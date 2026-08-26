# Documents MCP

`/documents/mcp` is the focused read-only connector for the USL Odoo
Distribution's governed Odoo–Paperless archive. The full `/mcp` surface
registers the same ten tools. Accounting and Projects endpoints register none
of them.

The compatible Odoo distribution is `usl_documents saas~19.3.1.7.6` or later.
The connector surface is `SERVER_VERSION` `0.22.0`; reconnect or refresh an MCP
client after upgrading so it discards its cached tool schemas.

## Tool contract

| Tool | Purpose | Important bounds |
| --- | --- | --- |
| `documents.search` | Browse a saved view or run exact, hybrid, or semantic retrieval inside the caller's governed scope | 25 results per call; `offset + limit <= 50`; excerpts <= 500 characters |
| `documents.get` | Read one document's governed metadata and guarded links | No OCR body or integrity hashes |
| `documents.get_content` | Page through authorized OCR text | 8,000 characters per call; offset <= 1,000,000 |
| `documents.find_similar` | Find local BGE-M3-nearest documents from one authorized source | 25 results; optional saved-view and structured candidate filters |
| `documents.get_versions` | List version metadata and guarded preview/download links | No checksums |
| `documents.list_tags` | List active archive tags | 100 rows per call |
| `documents.list_correspondents` | List active archive correspondents | 100 rows per call |
| `documents.list_types` | List active archive document types | 100 rows per call |
| `documents.list_saved_views` | List accessible shared and caller-owned Documents views | 100 rows per call; `all`, `shared`, or `personal` scope |
| `documents.get_links` | List linked Odoo records the caller can currently read | One governed document per call |

Every operation calls one explicit `usl.document.mcp_*` Odoo JSON-2 facade.
The Worker has no generic Documents model access, Paperless token, or direct
Paperless URL.

## Search modes

`documents.search` accepts these modes:

- `exact`: one bounded Paperless Tantivy request for title, OCR, archive
  metadata, and configured custom-field text, plus authorized Odoo metadata.
  It never calls the embedding service.
- `semantic`: meaning-only retrieval from Paperless's local BGE-M3 vector
  index. It never calls Gemini or another generative model.
- `hybrid`: exact retrieval first, followed by semantic refinement. Exact
  order is an immutable prefix; semantic-only roots are appended. If the local
  embedding service is unavailable, the exact prefix remains successful with
  a structured `semantic_unavailable` warning.

Odoo calculates record-rule, allowed-company, linked-record, availability, and
synchronized archive-permission candidates before either Paperless request.
Paperless intersects object permissions again, and Odoo rechecks every result.
The available structured filters are saved view, company, tag, correspondent,
document type, document date, archive-added date, source, confidentiality,
review state, linked/unlinked state, one allowed linked record, and background
document mode.

Search results report `mode`, the effective `query`, an optional `saved_view`,
and per-result provenance such as `paperless_lexical`, `paperless_semantic`,
`paperless_similar`, `odoo_metadata`, or `odoo_saved_view`.

## Saved views

Call `documents.list_saved_views` before guessing an ID. It returns only:

- active shared views allowed for the connected user's Documents groups; and
- that user's own active personal views.

The response contains the stable view ID/key, name, scope, system rule, safe
structured filters, synchronized tag/correspondent/type labels, and available
quick-filter labels. It does not return another user's private definition or a
raw Paperless synchronization error. A missing view and somebody else's
private view receive the same Odoo denial.

Pass the returned ID as `filters.saved_view_id` to `documents.search` or
`documents.find_similar`:

- With an explicit query, exact/hybrid/semantic retrieval runs only inside the
  saved view.
- With an empty query and a stored saved-view query, that stored query is
  replayed using the requested search mode.
- With an empty query and no stored query, Odoo browses the filtered view in
  deterministic document-date/archive-date order and makes no Paperless
  search call.

Explicit tool filters override matching stored filters; all other saved
filters remain active. Odoo's system-view domain remains additive, so an MCP
call cannot widen the saved view or the caller's record rules.

The MCP surface deliberately does not create, modify, synchronize, or delete
saved views. Those are user-visible Odoo/Paperless lifecycle writes and remain
in the Odoo Documents UI.

### Examples

List the connected user's saved views:

```json
{
  "name": "documents.list_saved_views",
  "arguments": {"scope": "all", "limit": 25, "offset": 0}
}
```

Browse one returned view without invoking Paperless search:

```json
{
  "name": "documents.search",
  "arguments": {
    "query": "",
    "filters": {"saved_view_id": 42},
    "limit": 10,
    "offset": 0
  }
}
```

Run meaning-only retrieval inside that same view:

```json
{
  "name": "documents.search",
  "arguments": {
    "query": "renewal obligations and termination notice",
    "mode": "semantic",
    "filters": {"saved_view_id": 42},
    "limit": 10,
    "offset": 0
  }
}
```

Find similar accounting evidence while retaining the view boundary:

```json
{
  "name": "documents.find_similar",
  "arguments": {
    "document_id": 317,
    "limit": 10,
    "filters": {
      "saved_view_id": 42,
      "confidentiality": "accounting"
    }
  }
}
```

## Authorization and privacy boundary

The Worker uses the connected person's Odoo URL, database, and API key. Odoo
applies current record rules, allowed companies, linked-record access, archive
availability, and synchronized binary permission before Paperless retrieval.
Missing, guessed, and inaccessible document IDs use the same denial.

Search returns excerpts of at most 500 characters. More OCR requires an
explicit `documents.get_content` call and pages of at most 8,000 characters.
An external MCP client or its model provider receives the excerpts and OCR
pages returned by these tools; connect only approved clients and minimize
content retrieval.

## Capacity and failure behavior

The queue serializes calls per Odoo origin at roughly one request per second.
Search returns at most 25 records inside a window of 50. OCR is paginated.
Paperless semantic scopes are chunked behind Odoo without an unscoped service
query. Track Worker/Durable Object requests, Odoo calls, Paperless lexical
latency, and local Ollama latency separately; do not raise concurrency to mask
retry or permission defects.

An unavailable semantic backend is a warning only in hybrid mode. Semantic-only
and similarity calls fail honestly. A saved-view browse remains available
without Paperless search, but guarded preview/download links still enforce
archive availability and permission when opened.

## Qualification and deployment

The release gate is:

1. Odoo `usl_documents_mcp` backend tests, including multi-company, hidden
   saved-view, complete-filter, stored-query, browse-without-Paperless, semantic
   scope, guessed-ID, bounded-output, and degradation cases.
2. MCP TypeScript typecheck and the complete Bun suite.
3. Wrangler deploy dry-run, with its compiled artifact SHA-256 recorded.
4. Endpoint composition proving exactly ten `documents.*` tools on
   `/documents/mcp` and `/mcp`, and none on Accounting or Projects.
5. Live Inspector calls with a short-lived governed Odoo key: list views,
   browse a view, hybrid and semantic search inside it, content/version/link
   reads, and a restricted-user negative probe. Remove the key afterward.

Deployment applies the existing `DocumentsAgent` Durable Object migration and
must not delete or recreate OAuth KV or Durable Object storage. If only the
Worker is faulty, deploy the preceding qualified MCP commit and refresh client
tool lists. If the Odoo facade contract is incompatible, roll back the complete
coordinated Odoo/MCP release cohort.

Source qualification on 2026-08-26 passed TypeScript typecheck, all 1,211 Bun
tests, and two byte-identical Wrangler dry-run builds. The compiled `index.js`
SHA-256 was
`3e65c76922223561d799cbe9ae67b4a1c923745c59b05a58786e831b5ecbf0ed`.
The coordinated Odoo `usl_documents` gate passed 166 post-install cases (174
test records) with no failures or errors.
