// Read-only GitHub metadata. Shared across worktrees; unknown is never "no PR".
export const PR_TTL = 5 * 60 * 1000;
const PR_GRACE = 5 * 60 * 1000;
const MAX_PAGES = 5;

export function githubRepository(url) {
  if (typeof url !== "string") return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+)$/.exec(url);
  if (!match) return null;
  const name = match[1].replace(/\/$/, "").replace(/\.git$/, "");
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name)
    ? name.toLowerCase() : null;
}

export function prTarget(remotes) {
  const urls = new Map();
  for (const line of remotes.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match) urls.set(match[1], githubRepository(match[2]));
  }
  // Don't guess a fork's identity from a different or unsupported origin.
  const head = urls.has("origin") ? urls.get("origin") : urls.get("upstream");
  const base = urls.get("upstream") ?? head;
  return head && base ? { head, base } : null;
}

export function prMarker(pr) {
  if (!pr) return null;
  if (pr.kind === "unknown") return { label: "PR ?", tone: "dim", title: pr.error };
  const label = pr.kind === "merged" ? "Merged" : pr.kind === "draft" ? "Draft" : "Open";
  return { label, tone: pr.kind === "merged" ? "ansi5" : pr.kind === "draft" ? "muted" : "ansi2",
    title: `${label} PR #${pr.number}\n${pr.url}${pr.count > 1 ? `\n${pr.count - 1} more PR(s) for this branch` : ""}` };
}

export class PullRequests {
  constructor({ remotes, pulls, now = () => Date.now() }) {
    this.loadRemotes = remotes; this.loadPulls = pulls; this.now = now;
    this.targets = new Map(); this.repositories = new Map();
    this.pendingTargets = new Map(); this.pendingRepos = new Map();
    this.tail = Promise.resolve();
  }

  async refresh(git, location) {
    if (!git?.repo || !git.branch || git.branch === "(detached)" || git.branch === "(initial)") return false;
    let target = this.targets.get(git.repo);
    if (!target || this.now() - target.at >= PR_TTL) {
      let work = this.pendingTargets.get(git.repo);
      if (!work) {
        work = (async () => {
          let entry;
          try { entry = { at: this.now(), value: prTarget(await this.loadRemotes(location)), error: null }; }
          catch { entry = { at: this.now(), value: null, error: "Cannot read this checkout's Git remotes. PR status is unavailable." }; }
          this.targets.set(git.repo, entry);
          return entry;
        })();
        this.pendingTargets.set(git.repo, work);
        work.finally(() => this.pendingTargets.delete(git.repo));
      }
      target = await work;
    }
    if (!target.value) return true;
    const repository = target.value.base, previous = this.repositories.get(repository);
    if (previous && this.now() - previous.at < PR_TTL) return false;
    if (this.pendingRepos.has(repository)) { await this.pendingRepos.get(repository); return true; }
    // Bound concurrency. GitHub reads never block the sidebar's Git refresh.
    const work = this.tail.then(async () => {
      let entry;
      try {
        const items = []; let complete = true, openComplete = false;
        for (const state of ["open", "closed"]) {
          let finished = false;
          for (let page = 1; page <= MAX_PAGES; page++) {
            const batch = await this.loadPulls(repository, page, state);
            if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid pull-request list.");
            for (const pr of batch) {
              if (pr.state !== state) continue;
              if (state === "closed" && !pr.merged_at) continue;
              if (!Number.isInteger(pr.number) || typeof pr.draft !== "boolean" || typeof pr.head?.ref !== "string") {
                throw new Error("GitHub returned incomplete PR status.");
              }
              const head = pr.head.repo?.full_name?.toLowerCase();
              if (head) items.push({ head, branch: pr.head.ref, number: pr.number,
                kind: state === "closed" ? "merged" : pr.draft ? "draft" : "open", url: `https://github.com/${repository}/pull/${pr.number}` });
            }
            if (batch.length < 100) { finished = true; break; }
          }
          if (state === "open") openComplete = finished;
          complete = complete && finished;
        }
        entry = { at: this.now(), validAt: this.now(), items, complete, openComplete, error: null };
      } catch (e) {
        // A failed attempt must not extend the last successful result's lifetime.
        entry = { ...previous, at: this.now(), items: previous?.items ?? [],
          error: String(e).replace(/^Error:\s*/, "").slice(0, 500) };
      }
      this.repositories.set(repository, entry);
    });
    this.pendingRepos.set(repository, work);
    this.tail = work.catch(() => {});
    try { await work; } finally { this.pendingRepos.delete(repository); }
    return true;
  }

  state(git) {
    if (!git?.repo || !git.branch || git.branch === "(detached)" || git.branch === "(initial)") return null;
    const target = this.targets.get(git.repo);
    if (!target) return null; // Initial load has no claimed status.
    if (target.error) return { kind: "unknown", error: target.error };
    if (!target.value) return null; // Not a supported GitHub remote.
    const data = this.repositories.get(target.value.base);
    if (!data) return null;
    if (data.validAt == null || this.now() - data.validAt >= PR_TTL + PR_GRACE
      || this.now() - target.at >= PR_TTL + PR_GRACE) {
      return { kind: "unknown", error: data.error ?? "PR status is unavailable; the last successful result is over ten minutes old." };
    }
    const matches = data.items.filter(pr => pr.head === target.value.head && pr.branch === git.branch);
    const found = matches.find(pr => pr.kind === "open") ?? matches.find(pr => pr.kind === "draft")
      ?? (data.openComplete ? matches[0] : null);
    // Promotion PRs do not mean a long-lived integration branch is finished.
    if (found?.kind === "merged" && ["develop", "main", "master"].includes(git.branch)) return null;
    return found ? { ...found, count: matches.length }
      : data.complete ? null : { kind: "unknown", error: "GitHub's PR list exceeded the lookup limit. This branch's status is unknown." };
  }
}
