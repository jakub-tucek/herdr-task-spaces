import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/herdr-task-spaces/SKILL.md"


class SkillTests(unittest.TestCase):
    def test_skill_is_self_contained_and_discoverable(self):
        text = SKILL.read_text()
        self.assertTrue(text.startswith("---\n"))
        metadata = text.split("---", 2)[1]
        self.assertIn("name: herdr-task-spaces", metadata)
        description = re.search(r"^description: (.+)$", metadata, re.MULTILINE).group(1)
        self.assertIn("Use when", description)
        self.assertLessEqual(len(description), 1024)
        self.assertLess(len(text.splitlines()), 100)

    def install_command(self, home):
        readme = (ROOT / "README.md").read_text()
        optional = readme.split("## Optional: teach your AI the grouping convention", 1)[1]
        command = optional.split("```sh\n", 1)[1].split("```", 1)[0]
        return subprocess.run(["sh", "-c", command], cwd=ROOT,
                              env={**os.environ, "HOME": str(home)}, capture_output=True, text=True, check=True)

    def test_optional_readme_step_copies_skill_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            self.install_command(home)
            target = home / ".agents/skills/herdr-task-spaces/SKILL.md"
            self.assertEqual(target.read_bytes(), SKILL.read_bytes())
            target.write_text("personal instructions")
            self.install_command(home)
            self.assertEqual(target.read_text(), "personal instructions")

    def test_optional_readme_step_preserves_existing_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            parent = home / ".agents/skills"
            parent.mkdir(parents=True)
            outside = home / "existing-skill"
            outside.mkdir()
            (outside / "SKILL.md").write_text("existing instructions")
            target = parent / "herdr-task-spaces"
            target.symlink_to(outside, target_is_directory=True)
            self.install_command(home)
            self.assertTrue(target.is_symlink())
            self.assertEqual((outside / "SKILL.md").read_text(), "existing instructions")


if __name__ == "__main__":
    unittest.main()
