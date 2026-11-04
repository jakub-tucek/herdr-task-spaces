import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.app = root / "app"
        self.app.mkdir()
        self.bin = root / "bin"
        self.bin.mkdir()
        command = self.bin / "herdr-app"
        command.write_text(f"#!{sys.executable}\nimport sys\nsys.exit(0 if sys.argv[1]=='check' else 2)\n")
        command.chmod(0o700)
        self.env = {**os.environ, "HERDR_APP_HOME": str(self.app), "XDG_DATA_HOME": str(root / "data"),
                    "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", "")}

    def install(self, *args, success=True):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/install.py"), *args], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def layout(self, name="personal"):
        path = self.app / "layouts" / f"{name}.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({"id": "root", "children": [
            {"id": "spaces", "size": {"px": 240}, "content": {"mod": "spaces", "props": {"github": False}}},
            {"id": "other", "content": {"mod": "annotator"}},
        ]}))
        return path

    def test_fresh_install_and_upgrade(self):
        self.install()
        target = self.app / "mods/task-spaces"
        self.assertEqual((target / "main.js").read_bytes(), (ROOT / "mods/task-spaces/main.js").read_bytes())
        self.assertFalse((target / "groups.test.mjs").exists())
        self.install()

    def test_layout_change_preserves_props_and_other_panels(self):
        path = self.layout()
        self.install("--layout", "personal", "--name", "my-task-spaces")
        tree = json.loads(path.read_text())
        self.assertEqual(tree["children"][0]["content"], {"mod": "my-task-spaces", "props": {"github": False}})
        self.assertEqual(tree["children"][0]["size"], {"px": 240})
        self.assertEqual(tree["children"][1]["content"]["mod"], "annotator")
        self.assertTrue(list((Path(self.env["XDG_DATA_HOME"]) / "herdr-task-spaces/backups").glob("*/personal.json")))

    def test_unknown_install_is_not_overwritten(self):
        target = self.app / "mods/task-spaces"
        target.mkdir(parents=True)
        (target / "main.js").write_text("personal code")
        self.install(success=False)
        self.assertEqual((target / "main.js").read_text(), "personal code")

    def test_modified_install_is_not_overwritten(self):
        self.install()
        target = self.app / "mods/task-spaces/main.js"
        target.write_text("local edits")
        self.install(success=False)
        self.assertEqual(target.read_text(), "local edits")

    def test_shipped_layout_and_paths_are_rejected_before_writes(self):
        for name in ["main", "terminals", "win98", "../outside"]:
            self.install("--layout", name, success=False)
        self.install("--name", "spaces", success=False)
        self.assertFalse((self.app / "mods").exists())

    def test_symlink_is_not_replaced(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        mods = self.app / "mods"
        mods.mkdir()
        (mods / "task-spaces").symlink_to(outside, target_is_directory=True)
        self.install(success=False)
        self.assertTrue((mods / "task-spaces").is_symlink())
        self.assertEqual(list(outside.iterdir()), [])

    def test_dry_run_has_no_writes(self):
        path = self.layout()
        before = path.read_bytes()
        self.install("--layout", "personal", "--dry-run")
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.app / "mods").exists())

    def test_layout_without_spaces_stays_unchanged(self):
        path = self.layout()
        path.write_text('{"content":{"mod":"custom-sidebar"}}')
        before = path.read_bytes()
        self.install("--layout", "personal", success=False)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.app / "mods").exists())

    def test_native_validation_failure_has_no_install_writes(self):
        path = self.layout()
        before = path.read_bytes()
        (self.bin / "herdr-app").write_text(f"#!{sys.executable}\nimport sys\nsys.exit(1)\n")
        self.install("--layout", "personal", success=False)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.app / "mods").exists())

    def test_layout_edit_during_validation_is_preserved(self):
        path = self.layout()
        (self.bin / "herdr-app").write_text(f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(path)!r}).write_text('new personal layout')\n")
        self.install("--layout", "personal", success=False)
        self.assertEqual(path.read_text(), "new personal layout")
        self.assertFalse((self.app / "mods").exists())


if __name__ == "__main__":
    unittest.main()
