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
  // Past the grace period the PR and its link stay, marked outdated.
  const stale = reader.state(git());
  assert.equal(stale.kind, "open");
  assert.equal(stale.stale, true);
  assert.equal(prMarker(stale, now).label, "Open ?");
  assert.equal(prMarker(stale, now).tone, "dim");
  assert.ok(prMarker(stale, now).url);
  assert.match(prMarker(stale, now).title, /Outdated: last confirmed/);
  assert.match(stale.error, /gh auth login/);
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
  assert.equal(prMarker(reader.state(git()), now).label, "Open ?");
  release([pr(true)]);
  await refresh;
  assert.equal(prMarker(reader.state(git())).label, "Draft");
});

test("a machine that goes away keeps its PR link, marked outdated", async () => {
  let now = 1, away = false;
  const reader = new PullRequests({ now: () => now,
    remotes: async () => { if (away) throw new Error("machine unreachable"); return remotes; },
    pulls: async (_repo, _page, state) => state === "open" ? [pr()] : [] });
  await reader.refresh(git(), {});
  assert.equal(prMarker(reader.state(git())).label, "Open");
  away = true; now += PR_TTL;
  await reader.refresh(git(), {});
  const marker = prMarker(reader.state(git()), now);
  assert.equal(marker.label, "Open ?");
  assert.equal(marker.url, "https://github.com/team/project/pull/42");
  assert.match(marker.title, /Outdated: last confirmed/);
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

test("a capped repo history falls back to the exact branch and confirms no PR", async () => {
  const filters = [];
  const reader = new PullRequests({ remotes: async () => remotes,
    pulls: async (_repo, _page, state, filter) => {
      if (filter) { filters.push(filter); return []; }
      return state === "open" ? [] : Array.from({ length: 100 }, () =>
        ({ ...pr(false, "old-task"), state: "closed", merged_at: "2026-11-04T10:00:00Z" }));
    } });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()), null);
  assert.deepEqual(filters, [{ head: "team/project", branch: "feature" }, { head: "team/project", branch: "feature" }]);
  await reader.refresh(git("remote-repo"), {});
  assert.equal(reader.state(git("remote-repo")), null);
  assert.equal(filters.length, 2, "worktrees share the targeted result, including confirmed absence");
});

test("exact-branch fallback finds old merges without borrowing a fork's PR", async () => {
  const reader = new PullRequests({ remotes: async () => remotes,
    pulls: async (_repo, _page, state, filter) => {
      if (state === "open") return [];
      if (!filter) return Array.from({ length: 100 }, () => ({ ...pr(false, "other"), state: "closed", merged_at: null }));
      return [{ ...pr(false, "feature", "fork/project"), state: "closed", merged_at: "2026-11-04T10:00:00Z" },
        { ...pr(), number: 43, state: "closed", merged_at: "2026-11-04T10:00:00Z" }];
    } });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "merged");
  assert.equal(reader.state(git()).number, 43);
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
  vm.runInNewContext(source + "\nglobalThis.api = { gitRemotes, githubPulls, githubApprovals };", context);
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
  await api.githubPulls("team/project", 1, "closed", { head: "fork/project", branch: "feature/a&b" });
  assert.ok(calls[3][1].some(arg => arg.includes("&head=fork%3Afeature%2Fa%26b")));
  assert.equal(calls[3].length, 2, "targeted requests also stay local");
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

test("an open release PR between long-lived branches is not this branch's badge", async () => {
  const release = { ...pr(false, "develop"), base: { ref: "master" } };
  const reader = new PullRequests({ remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open" ? [release, { ...pr(false, "feature"), base: { ref: "develop" } }] : [],
    approvals: async (_repo, numbers) => new Set(numbers) });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git("local-repo", "develop")), null);
  // Work branches keep their badge even when they target an integration branch.
  assert.equal(prMarker(reader.state(git("local-repo", "feature"))).label, "Approved");
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

test("approved badge uses the aggregate decision, preserving draft and merged priority", async () => {
  const reader = new PullRequests({ remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open" ? [pr(), pr(true, "draft")]
      : [{ ...pr(false, "merged"), state: "closed", merged_at: "2026-11-04T10:00:00Z" }],
    approvals: async () => new Set([42]) });
  await reader.refresh(git(), {});
  assert.equal(reader.state(git()).kind, "open");
  assert.equal(prMarker(reader.state(git())).label, "Approved");
  assert.match(prMarker(reader.state(git())).title, /Approved PR #42/);
  assert.equal(prMarker(reader.state(git("local-repo", "draft"))).label, "Draft");
  assert.equal(prMarker(reader.state(git("local-repo", "merged"))).label, "Merged");
});

test("approval lookups are batched per repository, shared across worktrees, and revoked on refresh", async () => {
  let now = 1, approved = true;
  const calls = [];
  const reader = new PullRequests({ now: () => now, remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open" ? [pr(), { ...pr(false, "other"), number: 43 }] : [],
    approvals: async (repo, numbers) => { calls.push({ repo, numbers }); return new Set(approved ? [42] : []); } });
  await Promise.all([reader.refresh(git(), {}), reader.refresh(git("remote-repo"), { on: "manjaro" })]);
  assert.deepEqual(calls, [{ repo: "team/project", numbers: [42, 43] }]);
  assert.equal(prMarker(reader.state(git())).label, "Approved");
  assert.equal(prMarker(reader.state(git("remote-repo"))).label, "Approved");
  approved = false; now += PR_TTL;
  await reader.refresh(git(), {});
  assert.equal(prMarker(reader.state(git())).label, "Open");
});

test("a failed review read keeps PR status without claiming approval", async () => {
  let now = 1, fail = false;
  const reader = new PullRequests({ now: () => now, remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open" ? [pr()] : [],
    approvals: async () => { if (fail) throw new Error("Unavailable"); return new Set([42]); } });
  await reader.refresh(git(), {});
  assert.equal(prMarker(reader.state(git())).label, "Approved");
  now += PR_TTL; fail = true;
  await reader.refresh(git(), {});
  assert.equal(prMarker(reader.state(git())).label, "Open");
  assert.equal(reader.state(git()).kind, "open");
});

test("a sidebar without an approvals reader still shows Open", async () => {
  const reader = new PullRequests({ remotes: async () => remotes,
    pulls: async (_repo, _page, state) => state === "open" ? [pr()] : [] });
  await reader.refresh(git(), {});
  assert.equal(prMarker(reader.state(git())).label, "Open");
});

test("GraphQL approval batches run locally and accept only APPROVED open non-drafts", async () => {
  const calls = [];
  const api = adapters(async (...args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ data: { repository: {
      pr42: { state: "OPEN", isDraft: false, reviewDecision: "APPROVED" },
      pr43: { state: "OPEN", isDraft: false, reviewDecision: "CHANGES_REQUESTED" },
      pr44: { state: "MERGED", isDraft: false, reviewDecision: "APPROVED" },
      pr45: { state: "OPEN", isDraft: true, reviewDecision: "APPROVED" },
      pr46: null } } }) };
  });
  const result = await api.githubApprovals("team/project", [42, 43, 44, 45, 46]);
  assert.deepEqual([...result], [42]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "gh");
  assert.equal(calls[0].length, 2, "review reads also stay local");
  assert.ok(calls[0][1].includes("graphql"));
  assert.ok(calls[0][1].some(arg => arg.includes("reviewDecision")));
});

test("a failed or unparsable review read throws instead of denying approval silently", async () => {
  await assert.rejects(adapters(async () => { throw new Error("Cannot start command"); }).githubApprovals("team/project", [42]), /review status is unavailable/);
  await assert.rejects(adapters(async () => ({ code: 1, stderr: "gh: Bad credentials" })).githubApprovals("team/project", [42]), /Bad credentials/);
  await assert.rejects(adapters(async () => ({ code: 0, stdout: "{}" })).githubApprovals("team/project", [42]), /review status/);
});
