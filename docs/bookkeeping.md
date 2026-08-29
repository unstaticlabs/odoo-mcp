# Accounting and bookkeeping operations

Accounting follows the same authority model as the rest of MCP 1.0: Odoo ACLs,
record rules, company scope, workflow validation, locks, hashes, and the
Irreversible Actions policy decide whether an operation succeeds. The connector
does not maintain a separate financial authorization policy.

## Choosing a route

Use a dedicated tool when its fixed intent saves reads or assembles a bounded
workflow. Use the full `/mcp` generic tools whenever Odoo flexibility is needed.

| Goal | Preferred route |
| --- | --- |
| Inspect expenses or vendor bills | `billing.*` read/audit tools |
| Prepare a draft expense | `billing.update_draft_expense` |
| Prepare a draft vendor bill | `billing.configure_draft_vendor_bill` |
| Submit/reset/approve an expense | matching `billing.*` lifecycle tool |
| Post, reset, reconcile, validate a receipt, or call another public workflow | `call_model_method` with the documented public method |
| Create/update any accounting record | generic `create_record` / `update_record` |
| Create a draft incoming receipt | `inventory.create_draft_vendor_receipt` |
| Preview tax/return/lock data | `bookkeeping.preview_write` |
| File source evidence | `billing.*attachment*` or `bookkeeping.link_source_document` |

Dedicated preparation tools enforce the promise in their names. For example,
`billing.configure_draft_vendor_bill` requires a draft `in_invoice` and accepts
the header/line preparation fields its workflow documents. That narrow contract
does not block generic access to `account.move`; Odoo decides generic calls.

## Advisory preview

`bookkeeping.preview_write` performs reads and domain-specific validation for:

- report external values;
- manual tax returns;
- return-type periodicity;
- lock exceptions.

It returns:

- advisory status;
- resolved target and existing records;
- observed lock dates;
- warnings;
- the would-write model/method/values;
- an exact suggested `create_record` or `update_record` call when resolvable.

It never writes, never issues an authorization artifact, and is never required
before a permitted operation. A `blocked` preview status means the preview could
not recommend that narrow operation; it is not an Odoo authorization decision.

There is no universal transaction-rollback dry run. Public methods can have
external or method-specific effects, so such a guarantee would be misleading.

## Public accounting workflows

Use `describe_model_api` before `call_model_method`. Supply named `kwargs` and
optional `ids`; do not synthesize positional arguments. Examples of likely
workflow names include `account.move.action_post` and version-dependent expense
methods, but API metadata from the connected installation is authoritative.

A method call that Odoo permits is sent even when it posts, pays, reconciles,
resets, validates, or deletes. An Agent denied by `usl_access_control` receives
the Odoo denial. A human with the required Odoo permission may succeed.

For an operation that must update several related accounting records atomically,
use one Odoo public method implementing the entire operation. Several MCP calls
are several SQL transactions.

## Multi-company context

Generic tools accept `odoo_context`. Typical values are:

```json
{
  "allowed_company_ids": [3, 8],
  "company_id": 8,
  "lang": "fr_FR",
  "tz": "Europe/Paris"
}
```

Selected-company context changes defaults and record-rule visibility; it does
not grant company access. Odoo still applies the user's allowed companies.

Dedicated expense reassignment validates the helper's fixed-intent invariants
and uses a context spanning source and target companies. Generic operations may
supply the documented context directly and receive Odoo's decision.

## Evidence and Documents

Attachment tools validate base64/PDF shape and size before sending bytes. They
preserve or add bounded provenance and return record URLs. Copy is preferred
when the old record must retain evidence; relink intentionally changes the
previous filing.

The Documents tools do not carry a Paperless credential. They call Odoo facade
methods as the authenticated Odoo user; Odoo computes the authorized document
scope before retrieval. A missing/denied Documents app is reported as a
capability/ACL problem, not silently converted into authorization.

## Mutation metadata

Every accounting mutation accepts `reason` and `idempotency_key` and returns an
`execution` block. The reason is bounded audit intent, not an Odoo RPC context.
Connector-authored correlation/idempotency keys are forwarded in reserved Odoo
context and cannot be spoofed by a generic caller.

When `idempotency_mode` is `unavailable`, a mutation gets one attempt. If its
response is lost, the result is `outcome_unknown`: inspect Odoo by record
identity, source reference, or correlation before retrying. Reuse the returned
key and identical arguments; never generate a fresh key for that retry.

## Error interpretation

Accounting errors retain Odoo's redacted detail and identify the likely refusing
layer:

- `odoo_acl` / `odoo_record_rule`: accept the authorization denial or ask an
  administrator to change Odoo rights;
- `odoo_irreversible_policy`: accept the policy denial;
- `workflow_state`: use a supported Odoo workflow/state;
- `lock_date`: resolve through authorized Odoo lock policy;
- `hash`: use an Odoo reversal/correction workflow;
- `schema`: rediscover fields/method signature;
- `odoo_validation`: correct the business input;
- `transport`: inspect connection/reliability metadata.

Do not seek a different MCP tool to bypass an Odoo authorization denial.

## Suggested agent procedure

1. Discover the model and public method instead of guessing.
2. Read the target record, company, current state, and stable business identity.
3. Choose a dedicated helper for lower call count or a generic call for full
   Odoo behavior.
4. Use one method for atomic business workflows.
5. Supply a concise reason and either omit the key for a fresh operation or use
   the existing key for an exact retry.
6. Read the execution outcome. Reconcile unknown outcomes before any retry.
7. Cite the returned Odoo URL in the answer.
