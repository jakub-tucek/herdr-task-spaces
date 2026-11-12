// Read-only GitHub metadata. Shared across worktrees; unknown is never "no PR".
export const PR_TTL = 5 * 60 * 1000;
const PR_GRACE = 5 * 60 * 1000;
const MAX_PAGES = 5;
// Long-lived branches; a PR between two of them promotes a release.
const INTEGRATION = ["develop", "main", "master"];

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

export function since(ms, now = Date.now()) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "a while ago";
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function prMarker(pr, now = Date.now()) {
  if (!pr) return null;
  if (pr.kind === "unknown") return { label: "PR ?", tone: "dim", title: pr.error };
  const label = pr.kind === "merged" ? "Merged" : pr.kind === "draft" ? "Draft" : pr.approved ? "Approved" : "Open";
  const tail = pr.count > 1 ? `\n${pr.count - 1} more PR(s) for this branch` : "";
  // Outdated: the last known state and its link, with a question mark and when
  // it was last confirmed, rather than losing both.
  const stale = pr.stale
    ? `\nOutdated: last confirmed ${since(pr.since, now)}${pr.error ? `\n${pr.error}` : ""}` : "";
  return { label: pr.stale ? `${label} ?` : label, url: pr.url, stale: Boolean(pr.stale),
    tone: pr.stale ? "dim" : pr.kind === "merged" ? "ansi5" : pr.kind === "draft" ? "muted" : pr.approved ? "ansi6" : "ansi2",
    title: `${label} PR #${pr.number}\n${pr.url}${tail}${stale}` };
}

const branchKey = (target, branch) => JSON.stringify([target.base, target.head, branch]);
function matchingPr(data, head, branch) {
  const matches = data.items.filter(pr => pr.head === head && pr.branch === branch);
  const found = matches.find(pr => pr.kind === "open") ?? matches.find(pr => pr.kind === "draft")
    ?? (data.openComplete ? matches[0] : null);
  return { matches, found };
}

export class PullRequests {
  constructor({ remotes, pulls, approvals, now = () => Date.now() }) {
    this.loadRemotes = remotes; this.loadPulls = pulls; this.loadApprovals = approvals; this.now = now;
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
          const previous = this.targets.get(git.repo);
          let entry;
          try { entry = { at: this.now(), value: prTarget(await this.loadRemotes(location)), error: null }; }
          // A machine that went away keeps the identity it last reported, so its
          // PRs stay readable here; the badge says the reading is outdated.
          catch { entry = { at: this.now(), value: previous?.value ?? null, error: "Cannot read this checkout's Git remotes. PR status may be outdated." }; }
          this.targets.set(git.repo, entry);
          return entry;
        })();
        this.pendingTargets.set(git.repo, work);
        work.finally(() => this.pendingTargets.delete(git.repo));
      }
      target = await work;
    }
    if (!target.value) return true;
    const repository = target.value.base;
    let changed = await this.refreshList(repository, repository);
    const data = this.repositories.get(repository);
    // A repository's history cap says nothing about this particular branch.
    if (data && !data.error && !data.complete && !matchingPr(data, target.value.head, git.branch).found) {
      changed = await this.refreshList(repository, branchKey(target.value, git.branch),
        { head: target.value.head, branch: git.branch }) || changed;
    }
    return changed;
  }

  async refreshList(repository, key, filter) {
    const previous = this.repositories.get(key);
    if (previous && this.now() - previous.at < PR_TTL) return false;
    if (this.pendingRepos.has(key)) { await this.pendingRepos.get(key); return true; }
    // Bound concurrency. GitHub reads never block the sidebar's Git refresh.
    const work = this.tail.then(async () => {
      let entry;
      try {
        const items = []; let complete = true, openComplete = false;
        for (const state of ["open", "closed"]) {
          let finished = false;
          for (let page = 1; page <= MAX_PAGES; page++) {
            const batch = await this.loadPulls(repository, page, state, filter);
            if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid pull-request list.");
            for (const pr of batch) {
              if (pr.state !== state) continue;
              if (state === "closed" && !pr.merged_at) continue;
              if (!Number.isInteger(pr.number) || typeof pr.draft !== "boolean" || typeof pr.head?.ref !== "string") {
                throw new Error("GitHub returned incomplete PR status.");
              }
              const head = pr.head.repo?.full_name?.toLowerCase();
              if (head) items.push({ head, branch: pr.head.ref, number: pr.number,
                base: typeof pr.base?.ref === "string" ? pr.base.ref : null,
                kind: state === "closed" ? "merged" : pr.draft ? "draft" : "open", url: `https://github.com/${repository}/pull/${pr.number}` });
            }
            if (batch.length < 100) { finished = true; break; }
          }
          if (state === "open") openComplete = finished;
          complete = complete && finished;
        }
        await this.markApproved(repository, items);
        entry = { at: this.now(), validAt: this.now(), items, complete, openComplete, error: null };
      } catch (e) {
        // A failed attempt must not extend the last successful result's lifetime.
        entry = { ...previous, at: this.now(), items: previous?.items ?? [],
          error: String(e).replace(/^Error:\s*/, "").slice(0, 500) };
      }
      this.repositories.set(key, entry);
    });
    this.pendingRepos.set(key, work);
    this.tail = work.catch(() => {});
    try { await work; } finally { this.pendingRepos.delete(key); }
    return true;
  }

  // One review read per list, for the open PRs that list actually carries.
  // A review failure never denies the PR itself: the badge stays Open.
  async markApproved(repository, items) {
    if (!this.loadApprovals) return;
    const numbers = [...new Set(items.filter(pr => pr.kind === "open").map(pr => pr.number))].sort((a, b) => a - b);
    if (!numbers.length) return;
    let approved;
    try { approved = await this.loadApprovals(repository, numbers); }
    catch { return; }
    for (const pr of items) if (pr.kind === "open" && approved?.has(pr.number)) pr.approved = true;
  }

  state(git) {
    if (!git?.repo || !git.branch || git.branch === "(detached)" || git.branch === "(initial)") return null;
    const target = this.targets.get(git.repo);
    if (!target) return null; // Initial load has no claimed status.
    // A failed remote read with nothing remembered is unknown; with a remembered
    // identity the PR list still works and the badge says it is outdated.
    if (target.error && !target.value) return { kind: "unknown", error: target.error };
    if (!target.value) return null; // Not a supported GitHub remote.
    let data = this.repositories.get(target.value.base);
    if (!data) return null;
    if (!data.complete && !matchingPr(data, target.value.head, git.branch).found) {
      data = this.repositories.get(branchKey(target.value, git.branch)) ?? data;
    }
    const old = data.validAt == null || this.now() - data.validAt >= PR_TTL + PR_GRACE
      || this.now() - target.at >= PR_TTL + PR_GRACE;
    const { matches, found } = matchingPr(data, target.value.head, git.branch);
    // Promotion PRs do not mean a long-lived integration branch is finished, and
    // a release PR from develop into master is not this checkout's work.
    if (INTEGRATION.includes(git.branch)
      && (found?.kind === "merged" || INTEGRATION.includes(found?.base))) return null;
    // An outdated reading still carries the PR and its link: keep showing them,
    // marked outdated, rather than dropping to "no idea".
    const outdated = old || Boolean(target.error);
    if (!found) {
      return old || !data.complete
        ? { kind: "unknown", error: data.error ?? target.error ?? "GitHub's PR list exceeded the lookup limit. This branch's status is unknown." }
        : null;
    }
    return { ...found, count: matches.length,
      ...(outdated ? { stale: true, since: data.validAt ?? null, error: data.error ?? target.error ?? null } : {}) };
  }
}
