import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../src/capabilities/index.js";
import { OdooClient } from "../../src/odoo/client.js";
import { requestContext } from "./fixtures.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connected(fetcher: typeof fetch) {
  const odoo = new OdooClient(8, 1024 * 1024, fetcher);
  const server = createCapabilityRegistry(odoo).createServer({ ...requestContext(), profile: "accounting" });
  const client = new Client({ name: "accounting-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("rebuilt accounting capabilities", () => {
  it("reads the authoritative company overview with a scoped company context", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/fields_get") ? Response.json({}) : Response.json([{
      id: 8,
      display_name: "USL Accounting Overview",
      company_id: [3, "USL"],
      readiness_status: "warning"
    }]));
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "accounting_get_overview",
      arguments: { company_id: 3, context: {} }
    });

    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url).endsWith("/json/2/rebuild.account.overview/search_read")).toBe(true);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      domain: [["company_id", "=", 3]],
      limit: 1,
      context: {
        allowed_company_ids: [3],
        company_id: 3,
        usl_agent_origin: "odoo-mcp",
        usl_correlation_id: "correlation-test"
      }
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        overview: {
          readiness_status: "warning",
          _ref: {
            model: "rebuild.account.overview",
            id: 8,
            url: "https://odoo.example/odoo/rebuild.account.overview/8"
          }
        }
      }
    });
  });

  it("projects the open annual close separately from the operational close and all-date totals", async () => {
    const fixture: Record<string, unknown> = {
      id: 81, company_id: [3, "[QA] Accounting scope"], posted_move_count: 27,
      open_annual_closing_id: [901, "[QA] Annual close"], annual_posted_move_count: 9,
      annual_journal_count: 2, annual_archived_journal_count: 1,
      latest_closing_period_id: [902, "[QA] Quarterly close"], latest_closing_date_to: "2024-09-30",
      draft_expense_count: 7, draft_only_expense_count: 2, submitted_expense_count: 1, approved_expense_count: 4
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const args = JSON.parse(String(init?.body));
      if (String(input).endsWith("/fields_get")) return Response.json(Object.fromEntries(
        Object.keys(fixture).map(field => [field, { type: field.endsWith("_id") ? "many2one" : "integer" }])
      ));
      return Response.json([Object.fromEntries(["id", ...args.fields].filter(field => field in fixture).map(field => [field, fixture[field]]))]);
    });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "accounting_get_overview", arguments: {
      company_id: 3, context: { allowed_company_ids: [3, 4], company_id: 4 }
    } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { overview: {
      posted_move_count: 27, open_annual_closing_id: fixture.open_annual_closing_id,
      annual_posted_move_count: 9, annual_journal_count: 2, annual_archived_journal_count: 1,
      latest_closing_period_id: fixture.latest_closing_period_id,
      draft_expense_count: 7, draft_only_expense_count: 2, submitted_expense_count: 1, approved_expense_count: 4,
      _scope: {
        posted_move_count: "all_dates", latest_closing_period_id: "latest_operational_close",
        open_annual_closing_id: "latest_ended_open_annual_workspace",
        draft_expense_count: { meaning: "expenses_to_process", states: ["draft", "submitted", "approved"], draft_only: false },
        expense_state_breakdown_available: true, annual_close_fields_available: true
      }
    } } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toContain("/rebuild.account.overview/");
      expect(JSON.parse(String(init?.body)).context).toMatchObject({ allowed_company_ids: [3], company_id: 3 });
    }
  });

  it("keeps an older server readable without inventing missing counts or annual data", async () => {
    const fixture: Record<string, unknown> = { id: 82, company_id: [3, "[QA] Legacy scope"], draft_expense_count: 5,
      latest_closing_period_id: [903, "[QA] Existing close"] };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/fields_get")) return Response.json({});
      const fields = JSON.parse(String(init?.body)).fields as string[];
      expect(fields).not.toContain("draft_only_expense_count");
      expect(fields).not.toContain("open_annual_closing_id");
      return Response.json([fixture]);
    });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "accounting_get_overview", arguments: { company_id: 3, context: {} } });
    expect(result.isError).not.toBe(true);
    const overview = (result.structuredContent as { data: { overview: Record<string, unknown> } }).data.overview;
    expect(overview.draft_expense_count).toBe(5);
    expect(overview).not.toHaveProperty("draft_only_expense_count");
    expect(overview).not.toHaveProperty("open_annual_closing_id");
    expect(overview._scope).toMatchObject({ expense_state_breakdown_available: false, annual_close_fields_available: false });
  });

  it("preserves the already deployed annual projection before expense breakdown is deployed", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/fields_get")) return Response.json({
        open_annual_closing_id: { type: "many2one" }, annual_posted_move_count: { type: "integer" },
        annual_journal_count: { type: "integer" }, annual_archived_journal_count: { type: "integer" }
      });
      const fields = JSON.parse(String(init?.body)).fields as string[];
      expect(fields).toContain("open_annual_closing_id");
      expect(fields).not.toContain("approved_expense_count");
      return Response.json([{ id: 83, open_annual_closing_id: false, draft_expense_count: 0 }]);
    });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "accounting_get_overview", arguments: { company_id: 3, context: {} } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { overview: {
      open_annual_closing_id: false, draft_expense_count: 0,
      _scope: { annual_close_fields_available: true, expense_state_breakdown_available: false }
    } } });
  });

  it("does not bypass a native overview metadata denial through another model", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/fields_get")
      ? Response.json({ name: "odoo.exceptions.AccessError", message: "[QA] Overview denied" }, { status: 403 })
      : Response.json([{ id: 84 }]));
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "accounting_get_overview", arguments: { company_id: 3, context: {} } });
    expect(result.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain("/rebuild.account.overview/fields_get");
  });

  it("uses Odoo 19 formatted grouping for key-account balances", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/json/2/account.account/search_read")) {
        return Response.json([{ id: 42, code: "512000", display_name: "Bank" }]);
      }
      if (url.endsWith("/json/2/account.move.line/formatted_read_group")) {
        return Response.json([{ account_id: [42, "Bank"], debit: 100, credit: 25, balance: 75 }]);
      }
      if (url.endsWith("/json/2/account.move.line/search_read")) return Response.json([]);
      if (url.endsWith("/json/2/account.move.line/search_count")) return Response.json(0);
      return Response.json({ message: "unexpected test request" }, { status: 500 });
    });
    const client = await connected(fetcher);

    const result = await client.callTool({
      name: "accounting_review_key_accounts",
      arguments: {
        company_id: 3,
        account_codes: ["512000"],
        date_to: "2026-08-30",
        context: {}
      }
    });

    expect(result.isError).not.toBe(true);
    const groupingCall = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/json/2/account.move.line/formatted_read_group")
    );
    expect(groupingCall).toBeDefined();
    expect(JSON.parse(String(groupingCall?.[1]?.body))).toMatchObject({
      groupby: ["account_id"],
      aggregates: ["debit:sum", "credit:sum", "balance:sum"],
      limit: 50
    });
  });

  it("reports the full visible open-item population independently of its bounded sample", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/account.account/search_read")) return Response.json([{ id: 42, code: "512000" }]);
      if (url.endsWith("/account.move.line/formatted_read_group")) return Response.json([]);
      if (url.endsWith("/account.move.line/search_count")) return Response.json(137);
      if (url.endsWith("/account.move.line/search_read")) return Response.json([{ id: 91 }, { id: 90 }]);
      return Response.json({ message: "unexpected test request" }, { status: 500 });
    });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "accounting_review_key_accounts", arguments: {
      company_id: 3, account_codes: ["512000", "512000", "999999"], date_to: "2026-08-30",
      open_item_limit: 2, context: { allowed_company_ids: [3, 4] }
    } });
    expect(result.isError).not.toBe(true);
    const domain = [["company_id", "=", 3], ["move_id.state", "=", "posted"], ["date", "<=", "2026-08-30"],
      ["account_id", "in", [42]], ["reconciled", "=", false]];
    expect(result.structuredContent).toMatchObject({ data: {
      open_item_count: 137, open_item_domain: domain, open_items_returned: 2,
      open_items_truncated: true, read_consistency: "separate_reads", missing_codes: ["999999"]
    } });
    for (const method of ["search_count", "search_read"]) {
      const call = fetcher.mock.calls.find(([url]) => String(url).endsWith(`/account.move.line/${method}`));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ domain,
        context: { allowed_company_ids: [3], company_id: 3 } });
    }
    const sample = fetcher.mock.calls.find(([url]) => String(url).endsWith("/account.move.line/search_read"));
    expect(JSON.parse(String(sample?.[1]?.body))).toMatchObject({ limit: 2, order: "date desc, id desc" });
    const count = fetcher.mock.calls.find(([url]) => String(url).endsWith("/account.move.line/search_count"));
    expect(JSON.parse(String(count?.[1]?.body))).not.toHaveProperty("limit");
  });

  it("returns an empty explicit population when no requested accounts are readable", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "accounting_review_key_accounts", arguments: {
      company_id: 4, account_codes: ["999999", "999999"], date_to: "2026-08-30", context: {}
    } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: {
      accounts: [], balances: [], open_items: [], missing_codes: ["999999"],
      open_item_count: 0, open_items_returned: 0, open_items_truncated: false,
      open_item_domain: [["company_id", "=", 4], ["move_id.state", "=", "posted"],
        ["date", "<=", "2026-08-30"], ["account_id", "in", []], ["reconciled", "=", false]]
    } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not invent a total when the native count is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/account.account/search_read")) return Response.json([{ id: 42, code: "512000" }]);
      if (url.endsWith("/account.move.line/search_count")) return Response.json({ message: "Count unavailable" }, { status: 403 });
      return Response.json([]);
    });
    const client = await connected(fetcher);
    const result = await client.callTool({ name: "accounting_review_key_accounts", arguments: {
      company_id: 3, account_codes: ["512000"], date_to: "2026-08-30", context: {}
    } });
    expect(result.isError).toBe(true);
  });

  it("keeps rebuilt report tools out of the generic default while making overview broad", () => {
    const registry = createCapabilityRegistry(new OdooClient());
    const defaultNames = registry.list("default").map((item) => item.name);
    const accountingNames = registry.list("accounting").map((item) => item.name);

    expect(defaultNames).toContain("accounting_get_overview");
    expect(defaultNames).not.toContain("accounting_get_management_report");
    expect(accountingNames).toEqual(expect.arrayContaining([
      "accounting_get_overview",
      "accounting_review_key_accounts",
      "accounting_get_management_report",
      "accounting_get_tax_report_context"
    ]));
  });
});
