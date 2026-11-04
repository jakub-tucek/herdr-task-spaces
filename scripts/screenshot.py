#!/usr/bin/env python3
"""Capture a native 16:10 catalog preview using inert demo spaces (macOS)."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "preview.png")
args = parser.parse_args()
if not shutil.which("sips"):
    parser.error("macOS sips is required for cropping; no app files changed")
root = Path(__file__).resolve().parents[1]
source = root / "mods/task-spaces"
app_home = Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app"))
subprocess.run(["herdr-app", "status"], check=True, capture_output=True)
driver = Path(tempfile.mkdtemp(prefix="task-spaces-demo-", dir=app_home / "mods"))
demo = []


def space(id, name, branch, repo="payments", machine=None, pr=None, active=False, status="idle"):
    folder = f"/demo/{repo}/{id}"
    common = json.dumps([machine, f"/demo/{repo}/.git"])
    demo.append({"w": {"id": id, "name": name, "folder": folder, "machine": machine,
                       "active": active, "status": status, "tabs": []},
                 "g": {"name": repo, "repo": common, "branch": branch, "linked": id != repo,
                       "ahead": 2 if active else 0, "behind": 0, "dirty": active}, "pr": pr})


space("payments", "payments", "develop")
space("plan", "orchestrator", "1234-g-backend-orchestrator", status="working")
space("cache", "query cache", "1235-g-backend-query-cache", pr="open", active=True)
space("validation", "validation", "1236-g-backend-validation", pr="draft")
space("reply", "reply button", "1237-g-frontend-reply-button", pr="open")
space("timeout", "fix-timeout", "1238-fix-timeout")
space("dashboard", "dashboard", "main", repo="dashboard")
space("docs", "getting started", "1240-g-docs-getting-started", repo="dashboard", pr="draft")
space("remote", "payments", "develop", machine="build-box")
space("worker", "queue worker", "1241-g-backend-queue-worker", machine="build-box", pr="open", status="working")
space("metrics", "metrics", "1242-metrics", machine="build-box", pr="draft")

fixtures = """
const demo = DEMO;
function spaces() { return demo.map(r => r.w); }
function panes() { return []; }
function machines() { return [{name:null,layout:'ready'},{name:'build-box',layout:'ready'}]; }
function layout() { return {id:'sidebar',size:{px:360}}; }
function props() { return {groups:[{key:'backend',label:'Backend'},{key:'frontend',label:'Frontend'},{key:'docs',label:'Documentation'}]}; }
function shared() { return {}; }
function setShared() {}
function run() {}
function openOverlay() {}
function window() { return {active:true}; }
const localStorage = {getItem:()=>null,setItem:()=>{}};
async function exec() { throw new Error('Demo: programs and network disabled'); }
const hc = exec, watchFolder = exec;
""".replace("DEMO", json.dumps(demo))
init = """
    this.git = Object.fromEntries(demo.map(r => [JSON.stringify([r.w.machine,r.w.folder]),r.g]));
    this.shown = new Set(spaces().map(s => s.id)); this.born = {};
    this.folded = new Set(); this.taskFolded = new Set(); this.pressed = null; this.over = null;
    this.machines = [{name:'build-box',state:'connected'}];
    this.pullRequests = {state:g => {
      const row = demo.find(r => r.g.repo === g?.repo && r.g.branch === g?.branch);
      return row?.pr ? {kind:row.pr,number:42,url:'https://github.com/example/payments/pull/42'} : null;
    }};
    return;
"""
wrapper = """
  render() {
    const t = theme();
    return h_flex().size_full().bg(t.background).text_color(t.foreground)
      .child(v_flex().w(360).h_full().flex_none().bg(t.chrome).child(this.renderSpaces()))
      .child(v_flex().flex_1().p(46).gap(24).justify_center()
        .child(div().text_size(12).text_color(t.accent).child('HERDR TASK SPACES'))
        .child(div().text_size(34).font_semibold().child('Worktrees by task.'))
        .child(div().text_size(20).text_color(t.muted).child('GitHub PR status beside each branch.'))
        .child(h_flex().gap(12)
          .child(div().px(10).py(5).rounded(5).bg(t.ansi2+'18').text_color(t.ansi2).text_size(14).child('Open'))
          .child(div().px(10).py(5).rounded(5).bg(t.muted+'18').text_color(t.muted).text_size(14).child('Draft')))
        .child(v_flex().p(20).gap(12).rounded(10).bg(t.surface).border_1().border_color(t.border)
          .child(div().text_size(14).text_color(t.muted).child('Group from your branch names'))
          .child(div().font_family('JetBrains Mono').text_size(15).child('1235-g-backend-query-cache'))
          .child(div().text_size(15).text_color(t.accent).child('Backend  /  query cache')))
        .child(v_flex().gap(12).text_size(15)
          .child(div().child('Local and SSH worktrees'))
          .child(div().child('Custom groups and collapsible headers'))
          .child(div().child('Ungrouped work directly under each repo')))
        .child(div().text_size(12).text_color(t.dim).child('Native GPUI · demo data · no real workspace changes')));
  }
"""
script = (source / "main.js").read_text()
script = re.sub(r'^import \{.*\} from "herdr";\n', 'import { theme } from "herdr";\n' + fixtures, script, flags=re.MULTILINE)
script = script.replace("init(_props, cx) {", "init(_props, cx) {" + init, 1)
script = script.replace("  render() {", "  renderSpaces() {", 1)
script = script.rstrip()[:-1] + wrapper + "\n}\n"
try:
    for name in ["groups.js", "pull-requests.js"]:
        shutil.copy2(source / name, driver / name)
    (driver / "main.js").write_text(script)
    (driver / "mod.json").write_text(json.dumps({"place":"none","overlay":{"width":1280,"height":800}}))
    subprocess.run(["herdr-app", "check", str(driver)], check=True)
    subprocess.run(["herdr-app", "do", "mod.open", json.dumps({"name":driver.name})], check=True)
    try:
        time.sleep(0.8)  # Native layout and first frame, not a screenshot of an intermediate render.
        with tempfile.TemporaryDirectory(prefix="task-spaces-shot-", dir=os.environ.get("TMPDIR")) as temp:
            raw = Path(temp) / "raw.png"
            subprocess.run(["herdr-app", "shot", str(raw)], check=True)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["sips", "--cropToHeightWidth", "800", "1280", str(raw), "--out", str(args.output)], check=True)
    finally:
        subprocess.run(["herdr-app", "do", "mod.open", json.dumps({"name":driver.name})], check=True)
finally:
    shutil.rmtree(driver)  # Only the newly created inert demo, never installed user mods.
