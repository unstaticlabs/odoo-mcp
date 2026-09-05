# Repository instructions

This repository is the canonical MCP for the self-hosted USL Odoo Distribution. The authoritative Odoo implementation is the sibling checkout at `/Users/roger/projects/odoo`; inspect that source before changing model names, fields, public methods, permissions, or workflow assumptions.

## Architecture invariants

- Register every tool through `src/capabilities/registry.ts`; do not create separately implemented domain MCP servers.
- Keep the generic substrate capable of cross-domain and long-tail work. Semantic tools are shortcuts, not walls.
- Treat profiles and `defer_loading` metadata as visibility controls only. Odoo credentials, ACLs, record rules, field access, company context, public-method dispatch, and workflow validation are the authority.
- Keep transport details behind `src/odoo/client.ts`. MCP contracts must not mirror incidental HTTP routes.
- One MCP business action must map to one Odoo-side transaction. Do not simulate atomicity by chaining mutations.
- Preserve `odoo_call_method` as a consequential, one-shot public-method escape hatch. Advertise it statically on writable named profiles and defer it only on the explicit `/mcp/all` discovery surface. Do not add an MCP allowlist or claim arbitrary method idempotency.
- Mutations receive one transport attempt. An ambiguous completion is `outcome: unknown`; never retry it automatically.
- Never log credentials, domains, prompts, tool arguments, record values, or tool output.

## Development

- Runtime: Node 26, npm, TypeScript NodeNext, strict Zod schemas, Vitest.
- Use `.js` extensions in relative TypeScript imports.
- Keep schemas strict and bounded; return structured envelopes and canonical Odoo record references.
- Add or update registry, schema, adapter, protocol, and evaluation tests with contract changes.
- Use `npm run check` before committing. Run `npm run test:integration` with a disposable Distribution fixture database for integration changes.
- Use Conventional Commits. Keep runtime, capability, evaluation, and documentation changes reviewable.
- Protected CI/GitOps is the default delivery path, not an exclusive one. When
  the user explicitly authorizes it, an operator may deploy MCP manually and
  may bypass CI. Before a production mutation, verify a current qualified,
  restorable backup, including the MCP OAuth vault where applicable, and
  confirm that the current GitOps checkout and desired-state ledgers describe
  the intended MCP and Odoo release pair.
- Release and promotion MRs intentionally require zero approving reviews so
  qualified pipelines can merge unattended. Generated SBOMs are passive build
  metadata and are not an admission or enforcement gate.

## Repository knowledge

- Durable repository rules belong here. No nested `AGENTS.md` is currently needed because the runtime, capabilities, tests, and docs share these invariants.
- Reusable procedures belong in `.agents/skills`; do not duplicate them into tool descriptions.
- MCP server instructions stay concise and universal. Workflow detail belongs in documentation or evaluation cases.
- Update `docs/refactor-spec.md` only when an architectural decision or authoritative Distribution fact changes; use the focused runbooks for operational changes.

## Required checks

```bash
npm ci
npm run check
npm run eval:validate
npm run test:integration
docker build -t usl-odoo-mcp .
```

The live integration suite is opt-in. Do not report it as passed when it skipped, and do not report Codex/Claude evaluation thresholds as met without pinned-model result artifacts.
