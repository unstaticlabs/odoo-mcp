import { afterEach, describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import { callOdoo } from "../odoo";
import { OdooQueue } from "../odoo-queue";
import { registerBookkeepingTools } from "./bookkeeping";

const originalFetch = globalThis.fetch;

function makeQueue() {
  return new OdooQueue(callOdoo, { minDelayMs: 0 });
}

function buildHandler(queue: OdooQueue, cache: TtlCache) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
  registerBookkeepingTools(server, () => props, queue, cache);
  return (server as any)._registeredTools["bookkeeping.get_snapshot"].handler;
}

interface CannedResponse {
  status: number;
  body: unknown;
}

const BASE_RESPONSES: Record<string, CannedResponse> = {
  "res.company.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      name: { type: "char" },
      country_id: { type: "many2one", relation: "res.country" },
      fiscalyear_lock_date: { type: "date" },
      tax_lock_date: { type: "date" },
      sale_lock_date: { type: "date" },
      purchase_lock_date: { type: "date" },
      hard_lock_date: { type: "date" }
    }
  },
  "res.company.search_read": {
    status: 200,
    body: [
      {
        id: 1,
        name: "Acme Corp",
        country_id: [10, "United States"],
        fiscalyear_lock_date: "2026-01-01",
        tax_lock_date: false,
        sale_lock_date: false,
        purchase_lock_date: false,
        hard_lock_date: false
      }
    ]
  },
  "account.report.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      name: { type: "char" },
      country_id: { type: "many2one", relation: "res.country" },
      root_report_id: { type: "many2one", relation: "account.report" }
    }
  },
  "account.report.search_read": {
    status: 200,
    body: [{ id: 100, name: "Tax Report", country_id: [10, "United States"] }]
  },
  "account.report.line.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      report_id: { type: "many2one", relation: "account.report" },
      code: { type: "char" },
      name: { type: "char" },
      parent_id: { type: "many2one", relation: "account.report.line" },
      sequence: { type: "integer" }
      // hierarchy_level intentionally absent (older Odoo version)
    }
  },
  "account.report.line.search_read": {
    status: 200,
    body: [{ id: 200, report_id: [100, "Tax Report"], code: "L1", name: "Line 1", parent_id: false, sequence: 1 }]
  },
  "account.report.expression.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      report_line_id: { type: "many2one", relation: "account.report.line" },
      label: { type: "char" },
      engine: { type: "char" },
      formula: { type: "char" },
      subformula: { type: "char" },
      date_scope: { type: "selection" }
    }
  },
  "account.report.expression.search_read": {
    status: 200,
    body: [
      {
        id: 300,
        report_line_id: [200, "Line 1"],
        label: "balance",
        engine: "tax_tags",
        formula: "",
        subformula: "",
        date_scope: "l10n_period"
      }
    ]
  },
  "account.report.external.value.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      date: { type: "date" },
      value: { type: "float" },
      target_report_expression_id: { type: "many2one", relation: "account.report.expression" },
      company_id: { type: "many2one", relation: "res.company" }
    }
  },
  "account.report.external.value.search_read": {
    status: 200,
    body: [
      {
        id: 400,
        date: "2026-02-15",
        value: 123.45,
        target_report_expression_id: [300, "balance"],
        company_id: [1, "Acme Corp"]
      },
      {
        id: 401,
        date: "2025-01-01",
        value: 50,
        target_report_expression_id: [300, "balance"],
        company_id: [1, "Acme Corp"]
      }
    ]
  },
  "account.return.type.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      name: { type: "char" },
      periodicity: { type: "selection" },
      deadline_days: { type: "integer" },
      report_id: { type: "many2one", relation: "account.report" }
      // deadline_months/deadline_start_date/deadline_end_type intentionally absent
    }
  },
  "account.return.type.search_read": {
    status: 200,
    body: [{ id: 900, name: "VAT Return", periodicity: "monthly", deadline_days: 20, report_id: [100, "Tax Report"] }]
  },
  "account.return.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      name: { type: "char" },
      company_id: { type: "many2one", relation: "res.company" },
      date_from: { type: "date" },
      date_to: { type: "date" },
      state: { type: "selection" },
      type_id: { type: "many2one", relation: "account.return.type" }
    }
  },
  "account.return.search_read": {
    status: 200,
    body: [
      {
        id: 950,
        name: "VAT 2026-02",
        company_id: [1, "Acme Corp"],
        date_from: "2026-02-01",
        date_to: "2026-02-28",
        state: "new",
        type_id: [900, "VAT Return"]
      }
    ]
  },
  "account.account.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      code: { type: "char" },
      name: { type: "char" },
      company_id: { type: "many2one", relation: "res.company" }
    }
  },
  "account.account.search_read": {
    status: 200,
    body: [
      { id: 500, code: "4000", name: "Key Account", company_id: [1, "Acme Corp"] },
      { id: 501, code: "4001", name: "Key Account 2", company_id: [1, "Acme Corp"] }
    ]
  },
  "account.move.line.fields_get": {
    status: 200,
    body: {
      id: { type: "integer" },
      account_id: { type: "many2one", relation: "account.account" },
      date: { type: "date" },
      name: { type: "char" },
      amount_residual: { type: "monetary" },
      balance: { type: "monetary" },
      move_id: { type: "many2one", relation: "account.move" },
      partner_id: { type: "many2one", relation: "res.partner" }
    }
  },
  "account.move.line.read_group": {
    status: 200,
    body: [{ account_id: [500, "Key Account"], balance: 1000, __count: 5 }]
  },
  "account.move.line.search_read": {
    status: 200,
    body: [
      {
        id: 600,
        account_id: [500, "Key Account"],
        date: "2026-03-01",
        name: "Line",
        amount_residual: 50,
        move_id: [700, "MV1"],
        partner_id: [800, "Partner"]
      }
    ]
  }
};

function buildFetchMock(overrides: Record<string, CannedResponse> = {}) {
  const responses = { ...BASE_RESPONSES, ...overrides };
  const calls: { model: string; method: string; body: any }[] = [];
  const fetchMock = mock(async (url: string, init: any) => {
    const marker = "/json/2/";
    const idx = url.indexOf(marker);
    const rest = url.slice(idx + marker.length);
    const lastSlash = rest.lastIndexOf("/");
    const model = rest.slice(0, lastSlash);
    const method = rest.slice(lastSlash + 1);
    const body = JSON.parse(init.body);
    calls.push({ model, method, body });

    const key = `${model}.${method}`;
    const resp = responses[key];
    if (!resp) {
      return new Response(JSON.stringify({ error: { message: `no canned response for ${key}` } }), { status: 404 });
    }
    return new Response(JSON.stringify(resp.status >= 400 ? resp.body : { result: resp.body }), {
      status: resp.status,
      headers: { "Content-Type": "application/json" }
    });
  });
  return { fetchMock, calls };
}

describe("bookkeeping.get_snapshot", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("requesting only key_accounts scope skips report/return models and omits their output keys", async () => {
    const { fetchMock, calls } = buildFetchMock();
    globalThis.fetch = fetchMock;
    const handler = buildHandler(makeQueue(), new TtlCache());

    const result = await handler({
      company: "Acme Corp",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      scopes: ["key_accounts"],
      key_account_codes: ["4000"]
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tax_report).toBeUndefined();
    expect(parsed.tax_returns).toBeUndefined();
    expect(parsed.external_values).toBeUndefined();
    expect(parsed.key_accounts).toBeDefined();

    const calledModels = new Set(calls.map((c) => c.model));
    for (const untouched of [
      "account.report",
      "account.report.line",
      "account.report.expression",
      "account.report.external.value",
      "account.return.type",
      "account.return"
    ]) {
      expect(calledModels.has(untouched)).toBe(false);
    }
  });

  test("missing account.return.type/account.return models produce warnings without failing the bundle", async () => {
    const { fetchMock } = buildFetchMock({
      "account.return.type.fields_get": {
        status: 404,
        body: { error: { message: "Object account.return.type doesn't exist" } }
      },
      "account.return.fields_get": {
        status: 404,
        body: { error: { message: "Object account.return doesn't exist" } }
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildHandler(makeQueue(), new TtlCache());

    const result = await handler({
      company: "Acme Corp",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      scopes: ["return_types", "tax_returns", "key_accounts"],
      key_account_codes: ["4000"]
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes("account.return.type"))).toBe(true);
    expect(parsed.warnings.some((w: string) => w.includes("account.return"))).toBe(true);
    expect(parsed.tax_returns.return_types.model).toBe("account.return.type");
    expect(parsed.tax_returns.return_types.records).toEqual([]);
    expect(parsed.tax_returns.existing_returns.model).toBe("account.return");
    expect(parsed.tax_returns.existing_returns.records).toEqual([]);
    expect(parsed.key_accounts.balances.records.length).toBeGreaterThan(0);
  });

  test("full scope request with 2+ key account codes issues a bounded number of Odoo calls", async () => {
    const { fetchMock } = buildFetchMock();
    globalThis.fetch = fetchMock;
    const queue = makeQueue();
    const handler = buildHandler(queue, new TtlCache());

    const before = queue.snapshot();
    const result = await handler({
      company: "Acme Corp",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      scopes: ["tax_report", "tax_returns", "return_types", "external_values", "key_accounts"],
      key_account_codes: ["4000", "4001"]
    });
    const delta = queue.delta(before);

    expect(result.isError).toBeUndefined();
    // One fields_get + one data call per involved model (~9 models across all 5 scopes),
    // regardless of how many key_account_codes are requested — no per-record loops.
    expect(delta.odoo_calls).toBeLessThanOrEqual(20);
  });

  test("many2one fields normalize to {id, name} instead of raw Odoo tuples, wrapped with model provenance", async () => {
    const { fetchMock } = buildFetchMock();
    globalThis.fetch = fetchMock;
    const handler = buildHandler(makeQueue(), new TtlCache());

    const result = await handler({
      company: "Acme Corp",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      scopes: ["key_accounts"],
      key_account_codes: ["4000"]
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.company.country).toEqual({ id: 10, name: "United States" });
    expect(parsed.key_accounts.balances.model).toBe("account.move.line");
    expect(parsed.key_accounts.balances.records[0].account_id).toEqual({ id: 500, name: "Key Account" });
  });

  test("omits lock-date fields absent from fields_get instead of requesting/crashing on them", async () => {
    const { fetchMock, calls } = buildFetchMock({
      "res.company.fields_get": {
        status: 200,
        body: {
          id: { type: "integer" },
          name: { type: "char" },
          country_id: { type: "many2one", relation: "res.country" },
          fiscalyear_lock_date: { type: "date" },
          tax_lock_date: { type: "date" },
          sale_lock_date: { type: "date" },
          purchase_lock_date: { type: "date" }
          // hard_lock_date intentionally absent (older Odoo version)
        }
      },
      "res.company.search_read": {
        status: 200,
        body: [
          {
            id: 1,
            name: "Acme Corp",
            country_id: [10, "United States"],
            fiscalyear_lock_date: "2026-01-01",
            tax_lock_date: false,
            sale_lock_date: false,
            purchase_lock_date: false
          }
        ]
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildHandler(makeQueue(), new TtlCache());

    const result = await handler({
      company: "Acme Corp",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      scopes: ["key_accounts"],
      key_account_codes: ["4000"]
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed.company.lock_dates)).not.toContain("hard_lock_date");

    const searchReadCall = calls.find((c) => c.model === "res.company" && c.method === "search_read");
    expect(searchReadCall?.body.fields).not.toContain("hard_lock_date");
  });

  test("account.report.line fields absent from fields_get (hierarchy_level) are not requested and output is still wrapped with model provenance", async () => {
    const { fetchMock, calls } = buildFetchMock();
    globalThis.fetch = fetchMock;
    const handler = buildHandler(makeQueue(), new TtlCache());

    const result = await handler({
      company: "Acme Corp",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      scopes: ["tax_report"],
      key_account_codes: []
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tax_report.reports.model).toBe("account.report");
    expect(parsed.tax_report.lines.model).toBe("account.report.line");
    expect(parsed.tax_report.expressions.model).toBe("account.report.expression");
    expect(parsed.tax_report.lines.records[0].code).toBe("L1");
    expect(parsed.tax_report.lines.records[0].hierarchy_level).toBeUndefined();

    const lineSearchRead = calls.find((c) => c.model === "account.report.line" && c.method === "search_read");
    expect(lineSearchRead?.body.fields).not.toContain("hierarchy_level");
    expect(lineSearchRead?.body.fields).toContain("code");
  });

  test("account.return.type deadline fields absent from fields_get are not requested", async () => {
    const { fetchMock, calls } = buildFetchMock();
    globalThis.fetch = fetchMock;
    const handler = buildHandler(makeQueue(), new TtlCache());

    const result = await handler({
      company: "Acme Corp",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      scopes: ["return_types"],
      key_account_codes: []
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tax_returns.return_types.model).toBe("account.return.type");
    expect(parsed.tax_returns.return_types.records[0].deadline_months).toBeUndefined();

    const returnTypeSearchRead = calls.find((c) => c.model === "account.return.type" && c.method === "search_read");
    expect(returnTypeSearchRead?.body.fields).not.toContain("deadline_months");
    expect(returnTypeSearchRead?.body.fields).not.toContain("deadline_start_date");
    expect(returnTypeSearchRead?.body.fields).not.toContain("deadline_end_type");
  });
});
