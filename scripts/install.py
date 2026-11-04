#!/usr/bin/env python3
"""Install Task Spaces without overwriting unknown or locally edited mods."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

FILES = ("groups.js", "pull-requests.js", "main.js", "mod.json")
PROJECT = "herdr-task-spaces"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as file:
            file.write(text)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def validate_target(target, receipt):
    if target.is_symlink():
        raise ValueError(f"Refusing to replace a symlink: {target}")
    if not target.exists():
        return
    if not target.is_dir():
        raise ValueError(f"Not a mod directory: {target}")
    if not isinstance(receipt, dict) or receipt.get("project") != PROJECT or set(receipt.get("files", {})) != set(FILES):
        raise ValueError(f"Existing mod has no matching receipt: {target}. Use --name with an unused name.")
    for name in FILES:
        file = target / name
        if file.is_symlink() or not file.is_file() or digest(file) != receipt["files"][name]:
            raise ValueError(f"Installed mod changed locally; preserve it before updating: {file}")


def layout_update(app_home, name, mod_name):
    if not name:
        return None, None, None
    if name in {"main", "terminals", "win98"} or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", name):
        raise ValueError("Choose a personal layout name, not a shipped layout or a path")
    path = app_home / "layouts" / f"{name}.json"
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Personal layout does not exist or is a symlink: {path}")
    original = path.read_bytes()
    tree = json.loads(original)
    found = False

    def replace(node):
        nonlocal found
        if not isinstance(node, dict):
            return
        content = node.get("content", {})
        if isinstance(content, dict) and content.get("mod") in {"spaces", mod_name}:
            content["mod"] = mod_name
            found = True
        for child in node.get("children") or []:
            replace(child)

    replace(tree)
    if not found:
        raise ValueError("No stock Spaces panel found in this layout; its other mods were left unchanged")
    return path, json.dumps(tree, indent=2) + "\n", original


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layout", help="Optional existing personal layout whose Spaces panel should use this mod")
    parser.add_argument("--name", default="task-spaces", help="Unused mod name, or an unmodified prior installation")
    parser.add_argument("--dry-run", action="store_true", help="Validate and describe changes without writing or loading the mod")
    args = parser.parse_args()
    if args.name == "spaces" or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.name):
        parser.error("Choose a personal lowercase mod name, not spaces or a path")
    root = Path(__file__).resolve().parents[1]
    source = root / "mods/task-spaces"
    app_home = Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app")).resolve()
    data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / PROJECT
    identity = hashlib.sha256(f"{app_home}:{args.name}".encode()).hexdigest()[:20]
    receipt_path = data_home / "installations" / f"{identity}.json"
    target = app_home / "mods" / args.name
    try:
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        validate_target(target, receipt)
        layout, text, original_layout = layout_update(app_home, args.layout, args.name)
        for name in FILES:
            if not (source / name).is_file():
                raise ValueError(f"Missing source file: {source / name}")
        if args.dry_run:
            print(f"Would install {target}")
            print(f"Would update {layout}" if layout else "No layout would change")
            return
        # Native validation happens before any install or layout write.
        subprocess.run(["herdr-app", "check", str(source)], check=True)
        validate_target(target, receipt)  # Detect edits made during validation.
        if layout and layout.read_bytes() != original_layout:
            raise ValueError("Layout changed during validation; no install writes were made. Run again after reviewing it.")
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = data_home / "backups" / stamp
        if target.exists() or layout or receipt_path.exists():
            backup.mkdir(parents=True)
            if target.exists():
                shutil.copytree(target, backup / args.name, symlinks=True)
            if layout:
                shutil.copy2(layout, backup / layout.name)
            if receipt_path.exists():
                shutil.copy2(receipt_path, backup / "install.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=f".{args.name}-", dir=target.parent) as temp:
            stage = Path(temp)
            for name in FILES:
                shutil.copy2(source / name, stage / name)
            target.mkdir(exist_ok=True)
            for name in FILES:  # Dependencies first, then the view and manifest.
                os.replace(stage / name, target / name)
        record = {"project": PROJECT, "mod": str(target), "files": {name: digest(target / name) for name in FILES}}
        atomic_write(receipt_path, json.dumps(record, indent=2) + "\n")
        if layout:
            if layout.read_bytes() != original_layout:
                raise ValueError(f"Layout changed during installation; left it unchanged. Mod installed; backup: {backup}")
            atomic_write(layout, text)
        print(f"Installed {target}")
        print(f"Updated {layout}; backup: {backup}" if layout else "No layout changed. Add this mod to a personal layout to show it.")
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
