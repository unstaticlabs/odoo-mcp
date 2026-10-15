# Reviewing key-account open items

`accounting_review_key_accounts` returns balances and a bounded sample of posted,
unreconciled journal items for the selected readable account codes in one company,
through `date_to` inclusive. The default sample limit is 50; the maximum is 100.

Use `open_item_count` for the full population visible to the calling identity.
`open_items_returned` describes the sample, and `open_items_truncated` says whether
the measured population exceeds that sample. A result with two returned items and
a count of 137 means there are more items to review; it does not mean only two
items remain open.

`open_item_domain` is the native Odoo domain used for both the count and sample:
company, posted move, inclusive cutoff date, selected account IDs, and
`reconciled = false`. To inspect it directly, use `odoo_search_records` on
`account.move.line` with that domain, the same caller and requested context, and
`allowed_company_ids` and `company_id` set to the selected company. Native ACLs,
record rules and field access still apply; the returned domain does not serialize
or replace those rules. A partly reconciled item remains included while its
native `reconciled` field is false. No residual threshold is invented.

Count, balances and sample use separate native reads. `read_consistency` is
`separate_reads`: concurrent posting or reconciliation can change the population
between calls. Refresh before acting on a changed ledger; this tool does not
provide an atomic closing snapshot. A failed count returns an error rather than
substituting the sample length as a total.

Missing or unreadable account codes appear in `missing_codes`. If none are
readable, the result has a zero count, an empty sample and an explicit empty
account-ID condition; it never falls back to searching every account.

The helper reads accounting facts. It does not post, reconcile, classify, change
balances, or draw tax conclusions.
