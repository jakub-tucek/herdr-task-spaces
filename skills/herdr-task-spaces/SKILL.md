---
name: herdr-task-spaces
description: Names and creates Git worktrees for Herdr Task Spaces using branch-defined task groups. Use when creating task branches or worktrees, choosing a workspace group, or opening an orchestrator or worker workspace in Herdr.
---

# Herdr Task Spaces

Group membership comes from branch names. The sidebar displays existing work;
it does not create branches, rename workspaces, or register groups.
For naming advice, stop after proposing a branch. Create work only when requested.

## Inspect before creating

1. Read the target repository's instructions and naming rules. Explicit user
   branch names and repository rules take precedence over this skill.
2. Identify the machine, repository, base ref, issue number, task, and optional
   group or parent workspace. Ask for missing information needed to create work.
   Use the supplied issue number; never invent one.
3. Inspect Git status, existing branches, and `git worktree list --porcelain` on
   the target machine. Reuse an existing checkout only when it is the requested
   one. Preserve unrelated worktrees, edits, and running sessions.

Proceed when the target, base, and branch name are known and the destination
does not collide with existing work.

## Choose the branch

| Intent | Form | Example |
| --- | --- | --- |
| Grouped task | `<issue>-g-<group>-<task>` | `1234-g-backend-query-cache` |
| Group lead | `<issue>-g-<group>-orchestrator` | `1235-g-backend-orchestrator` |
| Ordinary task | `<issue>-<task>` | `1236-fix-timeout` |

- Issue: digits, preserving any supplied leading zeros.
- Group: one lowercase alphanumeric token, such as `backend` or `frontend`.
- Task: lowercase kebab-case. Reserve the exact task `orchestrator` for the lead.
- Use the user's chosen group. For a worker, inherit an explicitly known parent
  group unless the user chooses another. Otherwise keep the task ordinary; ask
  when grouping is requested but the group is unclear. Do not infer membership
  from task keywords, directory names, or a checkout slot such as `z5`.
- Custom groups appear automatically. Labels/order come from the user's layout
  props, not a registration list. Different issue numbers may share a group.
- Ordinary tasks appear directly under the repository, without an Ungrouped
  header. Slash-based names do not opt into this grouping scheme.

Validate the complete candidate with `git check-ref-format --branch` before
creation. Explain when an explicitly requested name will not auto-group; keep
it unless the user approves another name. Renaming existing branches requires
separate approval, especially for published refs.

## Create on the correct machine

1. Use the confirmed base ref and an unused path to create the branch/worktree.
   Verify its path and checked-out branch afterward. Do not reset or recycle an
   occupied checkout to make room, or push without approval.
2. For SSH work, inspect `hc --skill` and the installed remote-command help;
   perform Git and filesystem operations on that machine. Keep local paths and
   machine-qualified IDs separate.
3. When the user asks to open the workspace in Herdr, read the installed
   `herdr-app --skill` and app home's `AGENTS.md`, then inspect `herdr-app ls`
   and `herdr-app status`. Reuse the exact existing space or create one space
   for the worktree using explicit machine/folder arguments. Preserve unrelated
   spaces and tabs. No space creation is needed for a branch-only request.
4. Start or message an agent only when requested, using herdr-core's installed
   instructions. Grouping needs no extra daemon, watcher process, or dummy space.

## Verify and report

- Confirm machine, checkout path, branch, base, and expected group.
- If opened in Herdr, verify the real space/tab IDs and visible placement.
  With the app unavailable, report a headless checkout rather than claiming a
  visible workspace exists.
- GitHub Draft/Open badges are optional cached metadata. A missing badge or
  `PR ?` is not permission to open a PR, change authentication, or rename a branch.
- Report what was created or reused and any mismatch between the requested
  branch convention and the sidebar. Keep existing manual group labels intact.
