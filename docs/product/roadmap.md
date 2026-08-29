# Roadmap

## Current: Odoo-authoritative gateway

- universal generic CRUD and public JSON-2 method calls on `/mcp`;
- Odoo-native denial diagnostics;
- optional accounting/inventory previews;
- authenticated dynamic API discovery;
- mutation execution metadata and idempotency negotiation;
- per-origin global request coordinator;
- shared target hardening for header and OAuth auth;
- layered agent guidance.

## Release dependency: Odoo atomic idempotency

Land `usl_json2_idempotency` in the Odoo repository through its separate review
and action-risk workflow. Deploy it before accepting `odoo_atomic` production
reliability. Required behavior and tests are in
[the protocol](../idempotency-protocol.md).

## Production qualification

- end-to-end forced response loss proves one committed mutation and replay;
- multiple MCP sessions/endpoints prove one in-flight call per origin;
- different origins progress independently;
- Agent protected actions remain denied by Odoo;
- authorized humans can perform protected actions;
- restricted ordinary users remain restricted;
- telemetry covers replay, conflict, unknown outcome, overload, target failure,
  and Odoo policy denial rates.

## Deferred product decisions

- endpoint composition/consolidation;
- optional operator hostname policies or strict-public routing profiles;
- further fixed-intent domain workflows where they materially reduce calls;
- richer discovery caching/ETag support;
- a standard operator dashboard for transport and idempotency health.
