---
name: commit-work
description: "Create reviewable Git commits by inspecting and selectively staging intended changes, choosing atomic boundaries, writing Conventional Commit messages, and running proportionate verification. Use when asked to stage, commit, split commits, craft commit messages, or push committed work."
license: MIT; see LICENSE.txt
metadata:
  upstream-inspiration: "https://github.com/softaworks/agent-toolkit/tree/main/skills/commit-work"
  adapted-for: "odoo-mcp"
---

# Commit work

Create commits that are independently understandable, reversible, and safe to review.

## Workflow

1. Inspect before staging:
   - `git status --short --untracked-files=all`
   - `git diff` and `git diff --stat`
   - recent `git log` to match repository conventions
2. Separate intended work from unrelated user changes. Never discard, rewrite, or include unrelated changes.
3. Choose boundaries by independent purpose and rollback:
   - keep implementation and its tests together;
   - separate unrelated features, mechanical formatting, dependency changes, generated artifacts, and documentation when they stand alone;
   - do not split a coherent change merely to create more commits.
4. Stage explicit paths or selected hunks. Do not use `git add .` or `git add -A`.
5. Review every staged commit with `git diff --cached --stat` and `git diff --cached`. Check for secrets, debug output, generated noise, and unrelated files.
6. Run the smallest verification that proves the staged change. For application changes, use the relevant gates from `.ci.json`:
   - `npm run typecheck`
   - `bun test`
   - `npx wrangler deploy --dry-run`
   Documentation- or skill-only commits may use structural validation instead of the application suite.
7. Commit using Conventional Commits:
   - `type(scope): imperative summary`
   - add a body when the reason is not obvious from the subject;
   - use `!` and a `BREAKING CHANGE:` footer when applicable.
8. Re-check `git status` after each commit and repeat until all intended work is committed.
9. Push only when the user explicitly requested it. Push the current branch to its configured upstream, then verify the local and upstream refs match.

## Commit quality

- Prefer established scopes from recent history; use `skills` for repository skill configuration.
- Keep subjects concise and specific.
- Describe what changed and why, not an implementation diary.
- A commit should leave the repository internally consistent and should be safe to cherry-pick or revert.
- If verification cannot run, state exactly what was not verified; do not present the commit as fully checked.

Use [references/commit-message-template.md](references/commit-message-template.md) when a message needs a body or breaking-change footer.

## Handoff

Report commit hashes and subjects, verification performed, push destination, and final working-tree state.
