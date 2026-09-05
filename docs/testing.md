# Testing

## Default gate

Use Node 26 and npm:

```bash
npm ci
npm run check
npm run eval:validate
docker build -t usl-odoo-mcp:test .
```

`npm run check` runs strict TypeScript checking, all `test/vps` unit/protocol tests, all `test/evals` corpus/interface tests, and a production build. CI performs the same checks and builds the container. The npm cache stores downloaded packages, while Buildx shares Docker layers between pull-request and publication builds. Test results themselves are always recomputed for each commit.

The default suite covers:

- strict schemas, bounded JSON/domain/context values, cursor behavior, canonical URLs, and serialization;
- target normalization/mapping, secret file handling, request size, CORS/host controls, semaphores, retries, cancellation, and error translation;
- direct auth, OAuth enrollment/vault/revocation, HTTP Streamable MCP, legacy stateless compatibility, and stdio;
- deterministic profiles, fail-closed exposure, unknown-aware catalogue search, schema-token budgets, deferred metadata, and structured tool outputs;
- generic substrate behavior, one-shot mutation outcomes, document facade calls, semantic context, rebuilt Accounting views, and fixed-intent actions;
- property-based cursor/domain/JSON/context invariants;
- the 60-task evaluation corpus, six ChatGPT golden prompts, and A/B/C/D/E surface generator.

## Live Distribution smoke suite

Run against a non-production or read-only Distribution identity:

```bash
export ODOO_INTEGRATION_ORIGIN=https://odoo-test.example.com
export ODOO_INTEGRATION_INTERNAL_ORIGIN=http://odoo-test:8069
export ODOO_INTEGRATION_DATABASE=usl_mcp_eval_v1
export ODOO_INTEGRATION_API_KEY=...
npm run test:integration
```

Without all required variables, the suite reports three skipped tests. A skip is not a pass. The current smoke suite verifies authenticated `/doc-bearer`, a bounded generic MCP read, and one-shot `odoo_call_method` with the public `res.users.context_get` method.

## Fixture database gate

Before production, instantiate a disposable database from `evals/fixtures/usl-eval-v1.json` using stable Odoo external IDs. Verify the installed module set and then add/run fixture-backed cases for:

- generic create/write/archive/delete and x2many values;
- field ACLs, record rules, restricted identities, and two-company contexts;
- document facade search/content/link/unlink;
- expense/batch state transitions and validation failures;
- vendor receipt creation and rollback on nested-line failure;
- one Odoo-side transaction for every multi-step business action;
- stale state and concurrent updates;
- a forced connection loss after mutation dispatch, producing unknown outcome with no replay.

Use separate identities for broad read, normal agent write, accounting approval, and irreversible-action denial. Never point mutating fixtures at production data.

## Protocol/client qualification

Qualify the built image with MCP Inspector or an equivalent protocol client:

1. initialize `/mcp`, `/mcp/all`, and each profile;
2. verify deterministic `tools/list`, strict input/output schemas, no deferred-loading hints on named profiles, and `_meta.defer_loading` only on `/mcp/all`;
3. submit invalid inputs, an unknown profile, cancelled requests, and response-overflow fixtures;
4. run at least eight concurrent reads against one target and two independent target mappings;
5. start `dist/stdio.js` as a subprocess and execute discovery/read;
6. connect current Codex and Claude Code/Desktop clients;
7. complete hosted ChatGPT and Claude OAuth enrollment, refresh, reconnect, and revoke flows;
8. rescan/reconnect the ChatGPT connector, verify the default 22-tool and degraded 8-tool surfaces, and run the feedback and discovery golden prompts.

Record client versions, MCP protocol negotiation, model IDs, date, image SHA, Distribution SHA, profile URL, and whether native tool search was enabled.

## Security and failure cases

Tests must assert behavior rather than treating annotations as controls:

- unauthorized tool execution reaches Odoo and is denied by the intended ACL/rule/policy;
- private or `@api.private` methods cannot pass the Odoo JSON-2 dispatcher;
- permanent deletion remains absent from default/thematic profiles and the public-method fallback is not used to disguise deletion;
- record-content prompt injection is returned as untrusted data and never executed;
- searches, fields, relations, attachments, arguments, depth, keys, bodies, and outputs stay bounded;
- credentials and sensitive Odoo values do not appear in structured logs;
- read retries occur only for classified transient failures;
- mutations and arbitrary public methods never retry automatically;
- actionable Odoo rejections say `not_applied`; ambiguous delivery or invalid post-success processing says `unknown`;
- unknown mutations expose sanitized known facts and a concrete reconciliation read while setting `retryable=false`;
- the Agent access cache stays at 50 LRU entries, coalesces cold loads and refreshes, stores failures only as unavailable status, and cancels timers and refreshes at shutdown;
- a cold connection makes exactly one identity request and one API-document request, while warm listing, search, and execution add no preflight calls;
- capability visibility requires Odoo-advertised model operations or public methods plus enabled staged features, while search retains unknown candidates without claiming to activate them, and stdio emits one list-change notification only when visible names change;
- the configured MCP public hostname remains same-origin allowed and OAuth vault files remain mode `0600` under a mode `0700` directory.

## Release evidence

Attach the following to a release/PR:

- `npm ci`, `npm run check`, evaluation validation, and image-build results;
- live smoke and fixture integration results, including skipped counts;
- default/all tool counts and schema-token snapshots;
- pinned Codex/Claude evaluation artifacts and acceptance-threshold summary;
- OAuth migration/backup/revoke check when enabled;
- migration and rollback confirmation.
