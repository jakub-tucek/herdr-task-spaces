import test from "node:test";
import assert from "node:assert/strict";
import { branchTask, foldKey, readFolded, sections, taskTitle, naturalCompare, configuredGroups, GROUPS } from "./groups.js";
import { prMarker } from "./pull-requests.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const row = (id, branch, repo = "/code/repo/.git", machine = null, i = 0) => ({
  w: { id, name: id, machine }, i,
  g: { branch, name: "repo", repo, linked: true },
});

test("only exact issue-g-group-task branches match, with automatic custom groups", () => {
  assert.deepEqual(branchTask("16431-g-security-fix-auth"), { issue: "16431", group: "security", task: "fix-auth", lead: false });
  assert.equal(branchTask("16100-g-indirect-orchestrator").lead, true);
  for (const branch of [null, "", "main", "develop", "(detached)", "feat/login", "security/runtime-db", "16431-sec-runtime-db", "g-security-db", "16431-g-security-", "16431-g-Security-db", "16431-g-security-fix_auth", "16431-g-infra--fix", "16431-g-infra-fix\n", "16431-g-security/fix", "issue-g-security-db"]) {
    assert.equal(branchTask(branch), null, String(branch));
  }
  assert.deepEqual(branchTask("00123-g-onboarding-welcome-email"), { issue: "00123", group: "onboarding", task: "welcome-email", lead: false });
});

test("one repo, several groups: fixed order, leads first, natural task order", () => {
  const input = [row("bank", "100-g-bank-task"), row("10", "101-g-security-task-10"), row("2", "102-g-security-task-2"), row("lead", "103-g-security-orchestrator"), row("old", "old-branch"), row("ind", "104-g-indirect-work")];
  const before = JSON.stringify(input);
  const [repo] = sections(input);
  assert.deepEqual(repo.groups.map(g => g.key), ["indirect", "security", "bank", null]);
  assert.deepEqual(repo.groups[1].rows.map(r => r.w.id), ["lead", "2", "10"]);
  assert.equal(JSON.stringify(input), before);
});

test("machine and repository boundaries, including worktree-only repos", () => {
  const result = sections([row("a", "1-g-bank-a"), row("b", "2-g-bank-b", "/code/other/.git"), row("remote", "3-g-bank-c", "/code/repo/.git", "server")]);
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map(r => r.key)).size, 3);
  assert.equal(new Set(result.map(r => r.groups[0].fold)).size, 3);
});

test("non-repo spaces and ungrouped work retain relative order; nothing disappears", () => {
  const plain = { w: { id: "shell", name: "~" }, i: 1, g: null };
  const result = sections([row("old1", "fix/auth"), plain, row("other", "1-g-bank-x", "/other/.git"), row("old2", "z5")]);
  assert.deepEqual(result.map(s => s.kind), ["repo", "space", "repo"]);
  assert.equal(result[1].row, plain);
  assert.deepEqual(result[0].groups[0].rows.map(r => r.w.id), ["old1", "old2"]);
  assert.equal(result.flatMap(s => s.kind === "space" ? [s.row] : s.groups.flatMap(g => g.rows)).length, 4);
});

test("titles derive from branches, preserve slots, leave legacy names alone", () => {
  assert.equal(taskTitle({ w: { name: "old label · z5" }, task: branchTask("16544-g-bank-payment-rules") }), "payment rules · z5");
  assert.equal(taskTitle({ w: { name: "z12" }, task: branchTask("16544-g-bank-orchestrator") }), "🧭 orchestrator · z12");
  assert.equal(taskTitle({ w: { name: "legacy" }, task: null }), "legacy");
});

test("fold state survives reload, rejects corrupt data and separates scopes", () => {
  const key = foldKey(null, "/repo/.git", "bank");
  assert.ok(readFolded(JSON.stringify([key])).has(key));
  for (const raw of [null, "oops", "null", "{}", "123"]) assert.equal(readFolded(raw).size, 0);
  assert.deepEqual([...readFolded('[1,"ok",null]')], ["ok"]);
  assert.notEqual(key, foldKey("remote", "/repo/.git", "bank"));
  assert.notEqual(key, foldKey(null, "/other/.git", "bank"));
});

test("natural ordering needs no Intl and handles long issue numbers", () => {
  assert.ok(naturalCompare("task-2", "task-10") < 0);
  assert.ok(naturalCompare("99-fix", "100-fix") < 0);
  assert.ok(naturalCompare("9999999999999999999", "10000000000000000000") < 0);
  assert.equal(naturalCompare("task-02", "task-2"), 0);
  assert.ok(naturalCompare("auth", "bank") < 0);
});

test("sidebar renders groups; collapse, reopen, row selection and compact navigation work", () => {
  const nodes = [], commands = [], saved = new Map();
  function element() {
    const node = { children: [], events: {} };
    const proxy = new Proxy(node, { get(target, key) {
      if (key === "then") return undefined;
      return (...args) => {
        if (key === "when") { if (args[0]) args[1](proxy); }
        else if (key === "child") node.children.push(args[0]);
        else if (key === "children") node.children.push(...args[0]);
        else if (key === "id") node.id = args[0];
        else if (key.startsWith("on_")) node.events[key + (typeof args[0] === "string" ? `:${args[0]}` : "")] = args.at(-1);
        return proxy;
      };
    } });
    nodes.push(node);
    return proxy;
  }
  const rows = [row("lead", "16431-g-security-orchestrator"), row("task", "16432-g-security-task", undefined, null, 1), row("old", "legacy", undefined, null, 2)];
  rows[1].g = { ...rows[1].g, ahead: 2, behind: 1, dirty: true };
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/export function /g, "function ")
    .replace("export default class Spaces", "globalThis.Sidebar = class Spaces");
  const context = {
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element,
    sections, taskTitle, readFolded, configuredGroups, prMarker, props: () => ({}), spaces: () => rows.map(r => r.w), shared: () => ({}),
    run: (...args) => commands.push(args),
    localStorage: { setItem: (key, value) => saved.set(key, value) },
  };
  vm.runInNewContext(source, context);
  const sidebar = new context.Sidebar();
  sidebar.taskFolded = new Set(); sidebar.pressed = null; sidebar.over = null;
  sidebar.pullRequests = { state: g => g?.branch.endsWith("orchestrator")
    ? { kind: "draft", number: 12, url: "https://github.com/team/project/pull/12" }
    : g?.branch.endsWith("task") ? { kind: "open", number: 13, url: "https://github.com/team/project/pull/13" } : null };
  const depths = new Map(), renderRow = sidebar.row.bind(sidebar);
  sidebar.row = (row, t) => { depths.set(row.w.id, row.tree); return renderRow(row, t); };
  const t = { dim: "dim", foreground: "fg", muted: "muted", ansi3: "orange" };
  const cx = { notify() {} };
  const expanded = sidebar.taskRows(rows, t);
  assert.equal(expanded.length, 5); // repo, one named header, three real spaces
  assert.equal(depths.get("old"), "repo");
  assert.equal(depths.get("task"), "task");
  assert.ok(!nodes.some(n => n.children.includes("Ungrouped")));
  assert.ok(nodes.some(n => n.id === "pr-state-lead" && n.children.includes("Draft")));
  assert.ok(nodes.some(n => n.id === "pr-state-task" && n.children.includes("Open")));
  assert.ok(!nodes.some(n => n.id === "pr-state-old"));
  sidebar.taskFolded.add(foldKey(null, "/code/repo/.git", null));
  assert.equal(sidebar.taskRows(rows, t).length, 5, "old Ungrouped folds cannot hide direct workspace rows");
  const header = nodes.find(n => n.id?.startsWith("group-") && n.id.includes("security"));
  assert.ok(header);
  header.events.on_click(null, cx);
  assert.equal(readFolded(saved.get("tasks.folded")).size, 2);
  assert.equal(sidebar.taskRows(rows, t).length, 3);
  const lastHeader = nodes.filter(n => n.id === header.id).at(-1);
  lastHeader.events.on_click(null, cx);
  assert.equal(sidebar.taskRows(rows, t).length, 5);
  const task = nodes.filter(n => n.id === "space-task").at(-1);
  task.events["on_mouse_down:left"](); task.events["on_mouse_up:left"](null, cx);
  assert.equal(commands.at(-1)[0], "space.select");
  assert.equal(commands.at(-1)[1].id, "task");
  sidebar.compact(rows[2], t);
  nodes.filter(n => n.id === "space-old").at(-1).events.on_click();
  assert.equal(commands.at(-1)[1].id, "old");
  assert.ok(!commands.some(([command]) => command === "space.move"));
});

test("markers create custom groups; configuration only sets display labels and order", () => {
  const input = [row("o", "1-g-onboarding-email"), row("t10", "2-g-team10-task"), row("t2", "3-g-team2-task"), row("b", "4-g-bank-task"), row("old", "5-bank-old")];
  const [repo] = sections(input);
  assert.deepEqual(repo.groups.map(g => g.key), ["bank", "onboarding", "team2", "team10", null]);
  assert.equal(repo.groups[1].label, "Onboarding");
  const [configured] = sections(input, [{ key: "team10", label: "Team Ten" }, { key: "bank", label: "Bank" }]);
  assert.deepEqual(configured.groups.map(g => g.key), ["team10", "bank", "onboarding", "team2", null]);
  assert.equal(configured.groups[0].label, "Team Ten");
});

test("issue numbers do not split groups; branch changes update membership", () => {
  const input = [row("a", "16431-g-security-db"), row("b", "16432-g-security-auth")];
  assert.equal(sections(input)[0].groups.length, 1);
  input[0].g.branch = "16431-g-bank-db";
  assert.deepEqual(sections(input)[0].groups.map(g => g.key), ["security", "bank"]);
  input[0].g.branch = "16431-db";
  assert.deepEqual(sections(input)[0].groups.map(g => g.key), ["security", null]);
});

test("layout props configure labels/order without source edits; malformed config uses defaults", () => {
  const groups = [{ key: "backend", label: "Backend" }, { key: "frontend", label: "UI" }];
  assert.deepEqual(configuredGroups(groups), groups);
  assert.deepEqual(configuredGroups([]), []);
  for (const bad of [null, {}, [null], [{ key: "BAD", label: "Bad" }], [{ key: "x", label: "" }], [...groups, groups[0]]]) {
    assert.equal(configuredGroups(bad), GROUPS);
  }
  const [repo] = sections([row("ui", "1-g-frontend-button"), row("api", "2-g-backend-query")], configuredGroups(groups));
  assert.deepEqual(repo.groups.map(g => g.label), ["Backend", "UI"]);
});
