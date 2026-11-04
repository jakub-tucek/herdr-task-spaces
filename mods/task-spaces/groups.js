// Optional label/order defaults. A branch marker creates a group without registration.
export const GROUPS = [
  { key: "indirect", label: "🌱 Indirect" },
  { key: "security", label: "🛡️ Security" },
  { key: "bank", label: "🏦 Bank" },
  { key: "infra", label: "🔧 Infrastructure" },
];

// Optional layout props override labels/order without modifying installed code.
export function configuredGroups(value) {
  if (!Array.isArray(value)) return GROUPS;
  const seen = new Set();
  for (const group of value) {
    if (!group || typeof group.key !== "string" || !/^[a-z0-9]+$/.test(group.key)
      || typeof group.label !== "string" || !group.label.trim() || group.label.length > 80 || seen.has(group.key)) return GROUPS;
    seen.add(group.key);
  }
  return value.map(({ key, label }) => ({ key, label }));
}

export function branchTask(branch) {
  if (typeof branch !== "string") return null;
  const match = /^([0-9]+)-g-([a-z0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(branch);
  if (!match || match[0] !== branch) return null;
  return { issue: match[1], group: match[2], task: match[3], lead: match[3] === "orchestrator" };
}

export function foldKey(machine, repo, group) {
  return JSON.stringify([machine ?? null, repo, group]);
}

export function readFolded(raw) {
  try {
    const list = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(list) ? list.filter(k => typeof k === "string") : []);
  } catch { return new Set(); }
}

export function taskTitle(row) {
  const task = row.task;
  if (!task) return row.w.name;
  const slot = /(?:^|[\s·])(?:z[0-9]+)$/.exec(row.w.name)?.[0]?.trim();
  const suffix = slot ? ` · ${slot.replace(/^·\s*/, "")}` : "";
  return `${task.lead ? "🧭 " : ""}${task.task.replace(/-/g, " ")}${suffix}`;
}

// The embedded JS runtime need not have Intl.Collator's numeric sorting.
export function naturalCompare(a, b) {
  const left = a.match(/[0-9]+|[^0-9]+/g) ?? [];
  const right = b.match(/[0-9]+|[^0-9]+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    let x = left[i], y = right[i];
    if (/^[0-9]+$/.test(x) && /^[0-9]+$/.test(y)) {
      x = x.replace(/^0+/, "") || "0";
      y = y.replace(/^0+/, "") || "0";
      if (x.length !== y.length) return x.length - y.length;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

// Pure display model. Never moves/renames real spaces or changes their IDs.
export function sections(rows, groups = GROUPS) {
  const out = [], repos = new Map();
  for (const row of rows) {
    if (!row.g?.repo) { out.push({ kind: "space", row }); continue; }
    const key = foldKey(row.w.machine, row.g.repo, null);
    let repo = repos.get(key);
    if (!repo) {
      repo = { kind: "repo", key, name: row.g.name, machine: row.w.machine ?? null, repo: row.g.repo, rows: [] };
      repos.set(key, repo);
      out.push(repo);
    }
    repo.rows.push({ ...row, task: branchTask(row.g.branch) });
  }
  for (const repo of repos.values()) {
    const configured = new Set(groups.map(g => g.key));
    const custom = [...new Set(repo.rows.map(r => r.task?.group).filter(Boolean))]
      .filter(key => !configured.has(key)).sort(naturalCompare)
      .map(key => ({ key, label: key[0].toUpperCase() + key.slice(1) }));
    // The null bucket preserves ordinary workspace order, without a UI header.
    repo.groups = [...groups, ...custom, { key: null }].flatMap(group => {
      const members = repo.rows.filter(r => (r.task?.group ?? null) === group.key);
      if (!members.length) return [];
      if (group.key) members.sort((a, b) => Number(b.task.lead) - Number(a.task.lead)
        || naturalCompare(a.task.task, b.task.task) || a.i - b.i);
      return [{ ...group, fold: foldKey(repo.machine, repo.repo, group.key), rows: members }];
    });
  }
  return out;
}
