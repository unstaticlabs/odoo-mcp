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
- the rich-text escaping contract on every write path: automatic chatter HTML formatting, preflight refusal of undeclared task/activity markup, the entity decode, the Markdown and collapsed-line-break warnings, and ordinary prose with angle brackets that must keep working;
- property-based cursor/domain/JSON/context invariants;
- the 60-task evaluation corpus, the ChatGPT golden prompts, and the A/B/C/D/E surface generator.

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

### Managed Agent draft expense correction fixture

The native draft expense correction fixture requires an owner-approved Internal
User (`base.group_user`) delegation with `read_only` access, as well as the
expense roles needed by the scenario. Initialize `usl.agent.current_identity`
and the MCP Agent access snapshot before attempting a mutation. Without that
delegation, identity bootstrap can fail before the expense action is reached;
report this as a fixture authorization failure, not a skipped or passing product
test. Keep these grants within the disposable QA identity.

### Project attachment bytes

`test/integration/project_attachment.test.ts` uploads through `projects_attach_file`
and reads the stored bytes, checksum, size and task ownership back from Odoo.
It requires a localhost Distribution, `ODOO_INTEGRATION_MUTATION_QA=1`, the standard
integration origin/database/API-key variables, and `ODOO_PROJECT_ATTACHMENT_FIXTURE`
pointing to a private JSON file with `synthetic: true`, `database`, `task_id` and
`company_id`. Use an existing disposable task that the fixture identity may read
and attach files to. The test leaves its synthetic attachment in that disposable
database; remove it with the fixture database after qualification.

The adapter sends canonical base64 text in Odoo's `raw` binary field. JSON-2
decodes that text to the original bytes. The validated 512 KiB upload uses a
fixed internal 768 KiB request allowance for `ir.attachment.create`; generic
calls keep their existing 256 KiB JSON limit. The removed `ir.attachment.datas` field
must not be sent, and a locally calculated size alone does not prove that Odoo
stored the file.

## Protocol/client qualification

Qualify the built image with MCP Inspector or an equivalent protocol client:

1. initialize `/mcp`, `/mcp/all`, and each profile;
2. verify deterministic `tools/list`, strict input/output schemas, no deferred-loading hints on named profiles, and `_meta.defer_loading` only on `/mcp/all`;
3. submit invalid inputs, an unknown profile, cancelled requests, and response-overflow fixtures;
4. run at least eight concurrent reads against one target and two independent target mappings;
5. start `dist/stdio.js` as a subprocess and execute discovery/read;
6. connect current Codex and Claude Code/Desktop clients;
7. complete hosted ChatGPT and Claude OAuth enrollment, refresh, reconnect, and revoke flows;
8. rescan/reconnect the ChatGPT connector and start a new conversation; verify the full default surface documented in the [tool catalogue](tool-catalogue.md) (two fewer tools without materialization) and the degraded direct-HTTP surface that remains when Odoo metadata is unavailable, then run the workflow, feedback and discovery golden prompts. OAuth without a valid complete snapshot returns warming rather than advertising a degraded manifest.

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

## Printable bill terms fixture

`test/integration/bill_terms.test.ts` uses an explicitly supplied disposable
fixture, rather than choosing write targets from ordinary business records.
Set `ODOO_INTEGRATION_BILL_TERMS_FIXTURE` to a private JSON file containing:
`disposable: true`, a database beginning `odoo_fb_`, a loopback `origin`, a
fixture Agent `key`, two selected `company_ids`, and `bills` with `0_posted`
and `1_draft` IDs. Keep the file and key outside version control. It exercises
actual native Agent discovery, MCP field help, cross-company draft terms,
omission, a posted generic terms write, one internal note append, unchanged
ledger lines and explicit clearing. Re-running intentionally appends a new
synthetic note; it must never target production.

Run `ODOO_INTEGRATION_BILL_TERMS_FIXTURE=<private-path> npm run test:integration`.
Other integration groups retain their own opt-in environment requirements;
report their skips separately from this fixture’s result.

The bill-terms SDK fixture requires a complete advertised native surface before
calling the shortcut. Fresh fixture registries can take more than the ordinary
30-second request budget to build their API document. Its initial read-only
discovery allows 90 seconds and fails explicitly if the surface is unavailable,
rather than treating a partial generic-tool surface as a missing bill tool.
Mutation attempts and production runtime timeouts are unchanged.
Model discovery uses the native user's language and has no `context` input.
The fixture checks meaningful English/French guidance there, then explicitly
requests English `fields_get` through existing `odoo_call_method` for stable
wording assertions. Do not expand the discovery tool schema for a fixture.

## Optional invoice company context

`accounting_get_invoice_context` accepts an optional strict `company_change`
object with an explicit `target_company_id`, `offset` (0–1000000, default 0) and
`limit` (1–100, default 50). This mode forwards exactly one
`account.move.get_company_change_context` call and returns the native result as
`context.company_change`, plus a canonical `invoice_ref`. It omits the ordinary
parallel activity/chatter reads so that the optional financial snapshot has one
native transaction boundary. Without the option the existing handler is unchanged.

Every page is a separate snapshot; compare native write dates and reread after
ordinary native changes. Counts and `complete`/`truncated` statuses apply to the
readable scope only. Inspect unavailable fields, optional sections and uncovered
company relations. Paid labels do not prove reconciliation; missing evidence is
information. Candidate IDs use native company domains and never match accounts
or taxes by code/name. Generic writes and native public methods retain their
existing authority. No company-change action or approval is introduced.

The native snapshot caps compact JSON at 262144 UTF-8 bytes, pages and relation
references at 100 records, text at 1024 characters and reference labels at 512.
The transport envelope is additional. See the Distribution's
`docs/product/invoice-company-context.md` for field, evidence and scope semantics.

## Relevant purchase attachment context

Ordinary `accounting_get_invoice_context` reads automatically add
`purchase_attachments` for a vendor bill or credit note whose native
`get_purchase_attachment_context` result is nonempty. The authenticated Agent
surface must advertise that method. Older backends, unknown discovery surfaces,
customer invoices and ordinary ungrouped vendor bills retain the ordinary
invoice context without a purchase-attachment section. No raw grouping JSON,
file bytes or fingerprints are read by the connector.

The first native page uses `offset: 0, limit: 50`. When `truncated` is true,
call `account.move.get_purchase_attachment_context` through `odoo_call_method`
with the same bill `ids` and `kwargs: {offset: next_offset, limit: 50}`
(`limit` may range from 1 to 100). Review action metadata uses native `ids`,
not positional arguments; following wizard actions use the returned wizard
`res_id` as their `ids`.
Each page and the ordinary invoice context are separate read snapshots. Re-read
before acting; native wizard checks remain authoritative if documents change.
The response includes native-readable metadata and native action guidance,
not a new connector mutation or approval workflow. A failed optional read
produces a bounded warning and retains the ordinary invoice context.

The live SDK regression is opt-in with
`ODOO_INTEGRATION_PURCHASE_ATTACHMENTS_FIXTURE=<private-path> npm run test:integration`.
Its private JSON declares `disposable: true`, loopback `origin`, an `odoo_fb_`
`database`, fixture Agent `key`, selected `company_ids`, and `cases` containing
`grouped`, `grouped_refund`, `ordinary` and `customer` invoice IDs readable by that Agent. Keep
credentials outside Git. Initial read-only discovery requires the complete native
surface and allows 90 seconds for a cold fixture API document. The test makes
native reads only, checks automatic
relevance and exact before/after record equality, and verifies no mutation or
file-content route was used. Report unrelated opt-in skips separately.

Seed PDF fixtures through native `ir.attachment.raw`; Odoo 19.3 ignores the
removed `datas` input. Set the attachment company explicitly to its bill's
company (or create it with that company selected). An administrator seeing a
file does not prove that the delegated Agent can read it. Verify nonempty
native document metadata through the intended Agent before qualifying the
journey; retain native company rules rather than broadening fixture access.
