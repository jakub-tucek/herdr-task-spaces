import test from "node:test";
import assert from "node:assert/strict";
import { PullRequests, PR_TTL, githubRepository, prTarget, prMarker } from "./pull-requests.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const git = (repo = "local-repo", branch = "feature") => ({ repo, branch });
const remotes = "origin\tgit@github.com:team/project.git (fetch)\norigin\tgit@github.com:team/project.git (push)";
const pr = (draft = false, branch = "feature", head = "team/project") => ({ number: 42, draft, state: "open", head: { ref: branch, repo: { full_name: head } } });

test("only github.com remote identities are accepted; forks retain their head identity", () => {
  assert.equal(githubRepository("ssh://git@github.com/Team/Project.git"), "team/project");
  for (const url of ["https://github.com.evil/repo/name", "https://token@github.com/team/project", "https://elsewhere/team/project", "git@github.com:../project", "git@github.com:team/project/extra"]) assert.equal(githubRepository(url), null);
  assert.deepEqual(prTarget(remotes + "\nupstream\tgit@github.com:upstream/project.git (fetch)"), { head: "team/project", base: "upstream/project" });
  assert.equal(prTarget("origin\tgit@elsewhere:team/project.git (fetch)\nupstream\tgit@github.com:team/project.git (fetch)"), null);
});

test("draft/open markers match repository AND branch; complete absence has no badge", async () => {
  const reader = new PullRequests({ remotes: async () => remotes, pulls: async () => [pr(true), pr(false, "ready"), pr(false, "unrelated", "fork/project")] });
  await reader.refresh(git(), {});
  assert.equal(prMarker(reader.state(git())).label, "Draft");
  assert.equal(prMarker(reader.state(git("local-repo", "ready"))).label, "Open");
  assert.equal(reader.state(git("local-repo", "unrelated")), null);
  assert.equal(reader.state(git("local-repo", "no-pr")), null);
  assert.ok(prMarker(reader.state(git())).title.includes("#42"));
});

test("concurrent worktrees and machines share one GitHub lookup per base repository", async () => {
  let reads = 0, remoteReads = 0;
  const reader = new PullRequests({ remotes: async () => { remoteReads++; return remotes; }, pulls: async () => { reads++; return [pr()]; } });
  await Promise.all([reader.refresh(git(), {}), reader.refresh(git(), {}), reader.refresh(git("remote-repo"), { on: "server" })]);
  assert.equal(remoteReads, 2); assert.equal(reads, 2);
  assert.equal(reader.state(git("remote-repo")).kind, "open");
});

test("TTL refresh updates draft to open and then removes a closed PR", async () => {
  let now = 1, result = [pr(true)], reads = 0;
  const reader = new PullRequests({ now: () => now, remotes: async () => remotes, pulls: async () => { reads++; return result; } });
  await reader.refresh(git(), {}); await reader.refresh(git(), {}); assert.equal(reads, 2);
  now += PR_TTL; assert.equal(reader.state(git()).kind, "draft");
  result = [pr(false)]; await reader.refresh(git(), {}); assert.equal(reader.state(git()).kind, "open");
  now += PR_TTL; result = []; await reader.refresh(git(), {}); assert.equal(reader.state(git()), null);
});

test("brief GitHub failures keep the last result; repeated failures cannot extend its grace period", async () => {
  let now = 1, failure = false;
  const reader = new PullRequests({ now: () => now, remotes: async () => remotes, pulls: async () => { if (failure) throw new Error("Install gh and run gh auth login on this computer."); return [pr()]; } });
  await reader.refresh(git(), {}); failure = true; now += PR_TTL;
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "open");
  now += PR_TTL;
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "unknown");
  assert.equal(prMarker(reader.state(git())).label, "PR ?");
  assert.match(reader.state(git()).error, /gh auth login/);
});

test("badges survive an in-flight refresh, expire after grace, and update when it completes", async () => {
  let now = 1, release;
  let hold = false;
  const reader = new PullRequests({ now: () => now, remotes: async () => remotes,
    pulls: async (_repo, _page, state) => {
      if (state === "closed") return [];
      if (hold) return new Promise(resolve => { release = resolve; });
      return [pr()];
    } });
  await reader.refresh(git(), {});
  hold = true; now += PR_TTL;
  const refresh = reader.refresh(git(), {});
  // Let remote discovery and the serial lookup reach the deferred GitHub read.
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  assert.equal(typeof release, "function");
  assert.equal(prMarker(reader.state(git())).label, "Open");
  assert.equal(reader.state(git("local-repo", "another-branch")), null);
  now += PR_TTL;
  assert.equal(reader.state(git()).kind, "unknown");
  release([pr(true)]);
  await refresh;
  assert.equal(prMarker(reader.state(git())).label, "Draft");
});

test("a failed initial lookup has no old badge to retain", async () => {
  const reader = new PullRequests({ remotes: async () => remotes,
    pulls: async () => { throw new Error("Offline"); } });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "unknown");
});

test("pagination finds later PRs; a capped list never claims no PR", async () => {
  let pages = [];
  const reader = new PullRequests({ remotes: async () => remotes, pulls: async (_repo, page, state) => { if (state === "closed") return []; pages.push(page); return page === 1 ? Array.from({ length: 100 }, (_, i) => pr(false, `other-${i}`)) : [pr(true)]; } });
  await reader.refresh(git(), {}); assert.deepEqual(pages, [1, 2]); assert.equal(reader.state(git()).kind, "draft");
  const capped = new PullRequests({ remotes: async () => remotes, pulls: async () => Array.from({ length: 100 }, () => pr(false, "other")) });
  await capped.refresh(git(), {}); assert.equal(capped.state(git()).kind, "unknown");
});

test("unsupported remotes and detached heads make no GitHub requests", async () => {
  let calls = 0;
  const reader = new PullRequests({ remotes: async () => "origin\tgit@elsewhere:team/project.git (fetch)", pulls: async () => { calls++; return []; } });
  await reader.refresh(git(), {}); await reader.refresh(git("detached", "(detached)"), {});
  assert.equal(calls, 0); assert.equal(reader.state(git()), null);
});

test("an Open PR takes precedence when the same branch also has a draft", async () => {
  const reader = new PullRequests({ remotes: async () => remotes, pulls: async () => [pr(true), { ...pr(false), number: 43 }] });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "open");
  assert.equal(reader.state(git()).count, 2);
  assert.match(prMarker(reader.state(git())).title, /1 more PR/);
});

function adapters(exec) {
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/export function /g, "function ")
    .replace("export default class Spaces", "class Spaces");
  const context = { exec, View: class {} };
  vm.runInNewContext(source + "\nglobalThis.api = { gitRemotes, githubPulls };", context);
  return context.api;
}

test("Git remotes run on the checkout machine; GitHub requests always run locally", async () => {
  const calls = [];
  const api = adapters(async (...args) => { calls.push(args); return { code: 0, stdout: args[0] === "git" ? remotes : "[]" }; });
  await api.gitRemotes({ cwd: "/remote/checkout", on: "server" });
  await api.githubPulls("team/project", 2);
  assert.equal(calls[0][0], "git"); assert.equal(calls[0][2].on, "server");
  assert.equal(calls[0][2].cwd, "/remote/checkout");
  assert.equal(calls[1][0], "gh"); assert.equal(calls[1].length, 2);
  assert.ok(calls[1][1].includes("github.com"));
  assert.ok(calls[1][1].includes("repos/team/project/pulls?state=open&sort=updated&direction=desc&per_page=100&page=2"));
  await api.githubPulls("team/project", 1, "closed");
  assert.ok(calls[2][1].includes("repos/team/project/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1"));
  assert.ok(!calls[1][1].includes("--method"));
});

test("a merged PR remains purple after TTL refresh; closed without merge has no badge", async () => {
  let now = 1, merged = false;
  const reader = new PullRequests({ now: () => now, remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open" ? (merged ? [] : [pr()]) :
      merged ? [{ ...pr(), state: "closed", merged_at: "2026-11-04T10:00:00Z" },
        { ...pr(false, "abandoned"), state: "closed", merged_at: null }] : [] });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "open");
  merged = true; now += PR_TTL;
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "merged");
  assert.equal(prMarker(reader.state(git())).label, "Merged");
  assert.equal(prMarker(reader.state(git())).tone, "ansi5");
  assert.match(prMarker(reader.state(git())).title, /Merged PR #42/);
  assert.equal(reader.state(git("local-repo", "abandoned")), null);
});

test("active PRs beat old merges; merged matches retain fork identity", async () => {
  const reader = new PullRequests({ remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open" ? [pr(true)] : [
      { ...pr(), state: "closed", merged_at: "2026-11-04T10:00:00Z" },
      { ...pr(false, "fork-only", "fork/project"), state: "closed", merged_at: "2026-11-04T10:00:00Z" }] });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "draft");
  assert.equal(reader.state(git("local-repo", "fork-only")), null);
});

test("long-lived branches never show Merged, but retain active PR badges", async () => {
  const branches = ["develop", "main", "master"];
  let active = false;
  let now = 1;
  const reader = new PullRequests({ now: () => now, remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open"
      ? active ? [pr(false, "develop"), pr(true, "main")] : []
      : branches.map(branch => ({ ...pr(false, branch), state: "closed", merged_at: "2026-11-04T10:00:00Z" })) });
  await reader.refresh(git(), {});
  for (const branch of branches) assert.equal(reader.state(git("local-repo", branch)), null, branch);
  active = true; now += PR_TTL;
  await reader.refresh(git(), {});
  assert.equal(reader.state(git("local-repo", "develop")).kind, "open");
  assert.equal(reader.state(git("local-repo", "main")).kind, "draft");
  assert.equal(reader.state(git("local-repo", "master")), null);
});

test("a truncated open list cannot claim an old merged PR is current", async () => {
  const reader = new PullRequests({ remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open"
      ? Array.from({ length: 100 }, () => pr(false, "other"))
      : [{ ...pr(), state: "closed", merged_at: "2026-11-04T10:00:00Z" }] });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "unknown");
});

test("missing gh produces local install/sign-in guidance without throwing into the view", async () => {
  const api = adapters(async () => { throw new Error("Cannot start command"); });
  await assert.rejects(api.githubPulls("team/project", 1), /Install gh.*gh auth login on this computer/);
});
