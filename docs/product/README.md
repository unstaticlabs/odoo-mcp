# Product overview

`odoo-mcp` is shared infrastructure for agents that use Odoo as an operational
system and second brain. It favors broad Odoo compatibility over a
connector-maintained catalog of permitted business actions.

## Product contract

- Bring a real Odoo user credential.
- Discover the connected installation's schema and public API.
- Use generic tools for the full Odoo surface and dedicated tools for efficient
  fixed-intent workflows.
- Let Odoo make authorization and action-policy decisions.
- Make retries, ambiguity, transport bounds, and diagnostics explicit.
- Return links and structured evidence agents can cite and reconcile.

The MCP does not make a user safer by silently contradicting Odoo permissions.
AI Agent restrictions belong in Odoo, where they cover every integration path,
including `sudo()`-mediated behavior guarded by USL policy.

## Consumers and endpoints

Claude, ChatGPT, IDE agents, and other MCP clients can connect to `/mcp` or a
focused domain endpoint. Header-auth capable clients use BYO-key headers;
OAuth-only clients use the built-in credential-vault shim.

All endpoints share authentication and safety plumbing. Focused endpoints are
about tool budgets and domain ergonomics, not separate authorization.

## Agent experience

The server gives agents three layers of guidance:

1. short server initialization instructions;
2. accurate tool descriptions and JSON schemas;
3. `odoo://guide/operations` plus `plan_odoo_operation` for detailed planning.

Dynamic discovery avoids guessing against customized/Studio-heavy Odoo
instances. API docs are preferred; ORM/view inspection is the honest fallback.

## Reliability promise

Reads have bounded transient retry. Mutations always expose a stable key and
truthful outcome. Exact replay is claimed only when Odoo advertises and enforces
the atomic idempotency protocol. Cross-call atomicity is never implied.

Every physical request shares a per-origin single-flight Durable Object, so
multiple agents, users, sessions, and endpoints cannot accidentally overlap
calls to the same Odoo origin.

## Documents

- [Safety design](../safety-design.md)
- [Idempotency protocol](../idempotency-protocol.md)
- [Architecture](architecture.md)
- [Authentication](auth.md)
- [Documents facade](documents.md)
- [Accounting](../bookkeeping.md)
- [Testing](../testing.md)
