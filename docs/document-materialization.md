# Document materialization: delivery and qualification

Materialization has three separate steps: Odoo authorizes and issues a short-lived
grant; the public gateway forwards a download; the client fetches and verifies the
bytes. A successful `documents_create_download_url` result proves only the first
step. MCP does not fetch file bytes, proxy Paperless, or verify client downloads.
Use `documents_get_content` for OCR/text when binary access is unnecessary.

## Gateway correction (2026-09-05)

Both GitOps gateway configurations placed a variable assignment after
`rewrite ... break`. Nginx stops rewrite-module processing at `break`, including
later `set` directives. The download therefore failed before reaching Odoo with
an empty upstream address. Assign the upstream before rewriting:

```nginx
set $upstream http://odoo-app:8069;
rewrite ^ /usl_documents/materialize break;
proxy_pass $upstream;
```

Staging must retain its own `odoo-staging-app` upstream. The owning files are
`komodo/stacks/prod-odoo-nbg1-2/usl-odoo-{production,staging}/gateway.conf` in GitOps;
an MCP image alone cannot correct this routing defect.

`access_log off` does not suppress error logs. Nginx error messages can contain
the original bearer URI. The grant and malformed-grant locations need
`error_log /dev/null` as well as disabled access logs. Maintenance must use a
dedicated non-logging handler, with `Cache-Control: private, no-store`,
`Referrer-Policy: no-referrer`, and `Retry-After`. Preserve content-free Odoo audit
events; do not add token-bearing proxy diagnostics. Audit outer proxies and
client tracing separately: a location-level rule cannot sanitize their logs.

Sources: [Nginx rewrite processing](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html),
[Nginx error logging](https://nginx.org/en/docs/ngx_core_module.html#error_log).

## Reproducible gateway qualification

The companion GitOps test exercises both checked-in gateway configurations with
their pinned Nginx images and synthetic bytes, never production documents:

```sh
USL_GATEWAY_DOCKER_TEST=1 python3 -m unittest discover \
  -s komodo/tests -p test_gateway_document_materialization.py -v
```

It covers GET, HEAD, Range/If-Range, invalid grants, private-route rejection,
header spoofing, forbidden methods, query strings, maintenance, unavailable
upstream responses, and connection failures without bearer URLs in logs.
The ordinary CI suite also enforces the directive order and logging contract.
Configuration syntax validation alone did not detect this incident.

## Client acceptance

1. Select a disposable document containing only synthetic QA text. Record its
   expected byte size and SHA-256, not a production filename or payroll content.
2. Read its context, then issue one grant for the selected version.
3. Fetch the returned HTTPS URL using the client's file/network facility. Never
   put a real URL in a shell command, diagnostic output, screenshot, or bug report.
4. Compare downloaded bytes with the expected size/checksum. HEAD alone does not
   prove that the client obtained the file. A DNS failure does not prove an Odoo
   authorization failure; a gateway 500 does not prove a private-hostname issue.
5. Revoke by non-secret `grant_id` in cleanup, including on download failure.
   Verify subsequent retrieval is denied. Never blindly reissue after an unknown
   issuance outcome; reconcile the grant audit first.
6. Refresh the developer connection and test from a new ChatGPT conversation.
   Record the actual callable schemas separately from capability-search results.

Do not declare ChatGPT end-to-end compatibility from a successful local gateway
fixture or a successful grant issuance/revocation pair. Client network access
and tool-schema acquisition remain separate acceptance checks.
