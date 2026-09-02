# Contributing

Create a focused branch, open a pull request against `main`, and use a
Conventional Commit title such as `fix(auth): reject an invalid redirect`.
The repository squash-merges pull requests, so the pull request title becomes
the commit subject on `main`.

Run the required checks before requesting a merge:

```bash
npm ci
npm run check
npm run eval:validate
docker build -t usl-odoo-mcp:test .
```

Run `npm run test:integration` only with a disposable Distribution fixture
database. A skipped integration suite is not a passing integration result.

## Git configuration

Configure Git to update one checked-out branch at a time and prune deleted
remote branches:

```bash
git config --local push.default simple
git config --local fetch.prune true
```

Push the current branch with `git push`; do not use `git push --all`. Fetch
before starting work, and delete merged local branches after GitHub removes
their remote counterparts.

## Odoo compatibility

The sibling Odoo Distribution repository is authoritative for model names,
fields, public methods, permissions, and workflow behavior. Inspect its source
before changing those contracts. A released MCP version is consumed by the
Distribution through an exact source commit, immutable image digest, and
compatibility-contract digest.
