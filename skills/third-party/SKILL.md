---
name: third-party
description: "Use when editing a repo that contains third_party/ or repo-share managed copies. Explains how to treat copied third-party/shared source: do not edit copies; edit canonical source repos and sync with repo-share."
---

# Third-party / repo-share managed source

Some repos keep committed source snapshots under `third_party/` using `repo-share`.

Rules:

1. Do not hand-edit files under `third_party/` or other paths listed in `.repo-share.json`.
2. Treat those files as read-only evidence unless the user explicitly asks to update the vendored snapshot.
3. To change shared code, edit the canonical source repo from `.repo-share.json` (usually `~/gh/<repo>`), commit it there, then run `repo-share sync <name>` in the consumer repo.
4. Use `repo-share check --locked` to verify copied snapshots in CI or when the canonical repo is not present.
5. If copied files became writable after checkout, run `repo-share protect [name]` or `repo-share check --locked` to reapply read-only permissions.

`repo-share` should not create or manage `AGENTS.md`. Machine metadata lives in `.repo-share-copy.json`; agent guidance lives in this skill.
