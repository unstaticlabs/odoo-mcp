import { afterEach, describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import { callOdoo } from "../odoo";
import { OdooQueue } from "../odoo-queue";
import {
  computeDeadline,
  diffExpectedReturns,
  generatePeriods,
  normalizePeriodicity,
  registerBookkeepingTools,
  registerReturnPreviewTools,
  registerSourceDocumentTools
} from "./bookkeeping";

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

// ---- Source documents & attachments tests (card ODOO1086) ----

const connProps = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-bookkeeping-key" };

function makeAgent() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const queue = new OdooQueue(callOdoo, { minDelayMs: 0 });
  registerSourceDocumentTools(server, () => connProps, queue);
  return server as any;
}

function getToolHandler(agent: any, name: string) {
  return agent._registeredTools[name].handler;
}

function jsonResponse(result: unknown, status = 200) {
  return new Response(JSON.stringify({ result }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("bookkeeping.list_source_documents", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("account.move: uses the verbatim res_field trap-avoidance domain and reads the move for tagging ids", async () => {
    const agent = makeAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/ir.attachment/search_read")) {
        return jsonResponse([
          { id: 1, name: "invoice.pdf", res_field: "invoice_pdf_report_file" },
          { id: 2, name: "original.pdf", res_field: false },
          { id: 3, name: "other.pdf", res_field: false }
        ]);
      }
      return jsonResponse([
        { message_main_attachment_id: [2, "original.pdf"], invoice_pdf_report_id: [1, "invoice.pdf"] }
      ]);
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "bookkeeping.list_source_documents");
    const result = await handler({ model: "account.move", record_id: 42 });

    expect(result.isError).toBeUndefined();
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0].url).toContain("/ir.attachment/search_read");
    expect(fetchCalls[0].body.domain).toEqual([
      "&",
      "&",
      ["res_model", "=", "account.move"],
      ["res_id", "=", 42],
      "|",
      ["res_field", "=", false],
      ["res_field", "=", "invoice_pdf_report_file"]
    ]);
    expect(fetchCalls[1].url).toContain("/account.move/read");

    const payload = JSON.parse(result.content[0].text);
    expect(payload.documents.find((d: any) => d.id === 2).tag).toBe("original_source");
    expect(payload.documents.find((d: any) => d.id === 1).tag).toBe("official_pdf");
    expect(payload.documents.find((d: any) => d.id === 3).tag).toBe("other");
    expect(payload.warnings).toEqual([]);
    expect(payload.metadata).toEqual({ odoo_calls: 2, cache_hits: 0, duration_seconds: expect.any(Number) });
  });

  test("non-account.move model: uses the plain res_field=false domain and skips the account.move read", async () => {
    const agent = makeAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse([{ id: 5, name: "doc.pdf", res_field: false }]);
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "bookkeeping.list_source_documents");
    const result = await handler({ model: "project.task", record_id: 7 });

    expect(result.isError).toBeUndefined();
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.domain).toEqual(["&", "&", ["res_model", "=", "project.task"], ["res_id", "=", 7], ["res_field", "=", false]]);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.documents[0].tag).toBe("other");
    expect(payload.metadata.odoo_calls).toBe(1);
  });

  test("search_read fields list never includes datas", async () => {
    const agent = makeAgent();
    let searchReadFields: string[] = [];
    const fetchMock = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/ir.attachment/search_read")) {
        searchReadFields = body.fields;
        return jsonResponse([]);
      }
      return jsonResponse([{}]);
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "bookkeeping.list_source_documents");
    await handler({ model: "account.move", record_id: 1 });

    expect(searchReadFields).not.toContain("datas");
  });

  test("account.move read failure is non-fatal: attachments still returned, tagged other, with a warning", async () => {
    const agent = makeAgent();
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/ir.attachment/search_read")) {
        return jsonResponse([{ id: 9, name: "doc.pdf", res_field: false }]);
      }
      return new Response(JSON.stringify({ error: { message: "computed field error" } }), { status: 500 });
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "bookkeeping.list_source_documents");
    const result = await handler({ model: "account.move", record_id: 1 });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.documents[0].tag).toBe("other");
    expect(payload.warnings.length).toBe(1);
    expect(payload.warnings[0]).toContain("account.move read failed");
  });
});

describe("bookkeeping.fetch_attachment", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("refuses without a second call when file_size exceeds the default max_bytes", async () => {
    const agent = makeAgent();
    const fetchMock = mock(async () => jsonResponse([{ name: "big.pdf", mimetype: "application/pdf", file_size: 99999999, type: "binary" }]));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 1, max_bytes: 10485760 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("99999999");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  test("refuses without a second call when file_size exceeds a custom max_bytes", async () => {
    const agent = makeAgent();
    const fetchMock = mock(async () => jsonResponse([{ name: "med.pdf", mimetype: "application/pdf", file_size: 5000, type: "binary" }]));
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 1, max_bytes: 1000 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("1000");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  test("url-type attachment: passes through url with no bytes fetched, one call only", async () => {
    const agent = makeAgent();
    const fetchMock = mock(async () =>
      jsonResponse([{ name: "link", mimetype: "application/pdf", file_size: 0, type: "url", url: "http://example.com/f.pdf" }])
    );
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 3, max_bytes: 10485760 });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.url).toBe("http://example.com/f.pdf");
    expect(payload.base64).toBeUndefined();
    expect(payload.datas).toBeUndefined();
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  test("happy path under the cap: fetches datas on a second call and returns base64", async () => {
    const agent = makeAgent();
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return jsonResponse([{ name: "small.pdf", mimetype: "application/pdf", file_size: 100, type: "binary" }]);
      }
      return jsonResponse([{ name: "small.pdf", mimetype: "application/pdf", file_size: 100, datas: "base64-content-here" }]);
    });
    globalThis.fetch = fetchMock;

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 4, max_bytes: 10485760 });

    expect(result.isError).toBeUndefined();
    expect(callCount).toBe(2);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.base64).toBe("base64-content-here");
    expect(payload.name).toBe("small.pdf");
  });

  test("no record found returns a plain mcpError", async () => {
    const agent = makeAgent();
    globalThis.fetch = mock(async () => jsonResponse([]));

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 404, max_bytes: 10485760 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });

  test("Odoo error surfaces as the structured JSON envelope with isError:true", async () => {
    const agent = makeAgent();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: { message: "Access Denied by Odoo" } }), { status: 403 })
    );

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 1, max_bytes: 10485760 });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope).toEqual({
      error: "permission_denied",
      model: "ir.attachment",
      method: "read",
      http_status: 403,
      details: "Access Denied by Odoo",
      recoverable: false
    });
    expect(result.content[0].text).not.toContain("secret-bookkeeping-key");
    expect(result.content[0].text).not.toContain("Bearer");
  });
});

// ---- Fiscal-return preview tests (card ODOO1077) ----

function buildPreviewHandler(queue: OdooQueue, cache: TtlCache) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
  registerReturnPreviewTools(server, () => props, queue, cache);
  return (server as any)._registeredTools["bookkeeping.preview_returns"].handler;
}

const VAT_XMLID = "l10n_fr_reports.vat_return_type";
const RESOLVE_VAT_RETURN_TYPE: Record<string, CannedResponse> = {
  "ir.model.data.search_read": {
    status: 200,
    body: [{ model: "account.return.type", res_id: 900 }]
  }
};

describe("bookkeeping.preview_returns", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("resolves an XML ID to its account.return.type record and surfaces its raw discovered fields", async () => {
    const { fetchMock, calls } = buildFetchMock(RESOLVE_VAT_RETURN_TYPE);
    globalThis.fetch = fetchMock;
    const handler = buildPreviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: 1, from: "2026-02-01", to: "2026-02-28", return_type_xmlids: [VAT_XMLID] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.return_types).toHaveLength(1);
    expect(parsed.return_types[0].id).toBe(900);
    expect(parsed.return_types[0].periodicity).toBe("monthly");
    expect(parsed.return_types[0].report_id).toEqual({ id: 100, name: "Tax Report" });
    expect(parsed.configuration_issues).toEqual([]);

    // XML ID resolution went through ir.model.data with the module/name split.
    const resolveCall = calls.find((c) => c.model === "ir.model.data" && c.method === "search_read");
    expect(resolveCall?.body.domain).toEqual([
      ["module", "=", "l10n_fr_reports"],
      ["name", "=", "vat_return_type"]
    ]);
    const typeSearch = calls.find((c) => c.model === "account.return.type" && c.method === "search_read");
    expect(typeSearch?.body.domain).toEqual([["id", "in", [900]]]);
  });

  test("blank periodicity produces a configuration issue and NO guessed periods", async () => {
    const { fetchMock } = buildFetchMock({
      ...RESOLVE_VAT_RETURN_TYPE,
      "account.return.type.fields_get": {
        status: 200,
        body: {
          id: { type: "integer" },
          name: { type: "char" },
          periodicity: { type: "selection" },
          deadline_periodicity: { type: "selection" },
          deadline_days_delay: { type: "integer" },
          auto_generate: { type: "boolean" },
          report_id: { type: "many2one", relation: "account.report" }
        }
      },
      "account.return.type.search_read": {
        status: 200,
        body: [
          {
            id: 900,
            name: "CA12 TVA oct. 2025 - sept. 2026",
            periodicity: false,
            deadline_periodicity: false,
            deadline_days_delay: 19,
            auto_generate: true,
            report_id: false
          }
        ]
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildPreviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: 1, from: "2025-10-01", to: "2026-09-30", return_type_xmlids: [VAT_XMLID] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.expected_returns).toEqual([]);
    expect(parsed.configuration_issues).toHaveLength(1);
    expect(parsed.configuration_issues[0]).toContain("blank or unrecognized");
    expect(parsed.configuration_issues[0]).toContain("CA12");
  });

  test("an unresolvable XML ID degrades into configuration_issues without throwing", async () => {
    const { fetchMock } = buildFetchMock({
      "ir.model.data.search_read": { status: 200, body: [] }
    });
    globalThis.fetch = fetchMock;
    const handler = buildPreviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: 1, from: "2026-01-01", to: "2026-03-31", return_type_xmlids: ["bad.module_xmlid"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.return_types).toEqual([]);
    expect(parsed.expected_returns).toEqual([]);
    expect(parsed.configuration_issues.some((c: string) => c.includes("bad.module_xmlid"))).toBe(true);
  });

  test("end-to-end exists-matching: a monthly period matching an existing return is flagged exists:true", async () => {
    const { fetchMock } = buildFetchMock(RESOLVE_VAT_RETURN_TYPE);
    globalThis.fetch = fetchMock;
    const handler = buildPreviewHandler(makeQueue(), new TtlCache());

    // BASE account.return.search_read returns a Feb 2026 return (date_from 2026-02-01, date_to 2026-02-28).
    const result = await handler({ company: 1, from: "2026-02-01", to: "2026-02-28", return_type_xmlids: [VAT_XMLID] });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.expected_returns).toHaveLength(1);
    expect(parsed.expected_returns[0]).toMatchObject({
      date_start: "2026-02-01",
      date_end: "2026-02-28",
      deadline: "2026-03-20", // period end + deadline_days (20)
      exists: true
    });
  });

  test("end-to-end exists-matching: a period with no matching existing return is flagged exists:false", async () => {
    const { fetchMock } = buildFetchMock(RESOLVE_VAT_RETURN_TYPE);
    globalThis.fetch = fetchMock;
    const handler = buildPreviewHandler(makeQueue(), new TtlCache());

    // January window; the only existing return (BASE) is February → no match.
    const result = await handler({ company: 1, from: "2026-01-01", to: "2026-01-31", return_type_xmlids: [VAT_XMLID] });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.expected_returns).toHaveLength(1);
    expect(parsed.expected_returns[0]).toMatchObject({ date_start: "2026-01-01", date_end: "2026-01-31", exists: false });
  });
});

describe("preview_returns pure functions", () => {
  test("normalizePeriodicity maps known cadences and rejects blanks", () => {
    expect(normalizePeriodicity("monthly")).toBe("monthly");
    expect(normalizePeriodicity("quarterly")).toBe("quarterly");
    expect(normalizePeriodicity("annual")).toBe("yearly");
    expect(normalizePeriodicity("yearly")).toBe("yearly");
    expect(normalizePeriodicity(false)).toBeNull();
    expect(normalizePeriodicity("")).toBeNull();
    expect(normalizePeriodicity("whenever")).toBeNull();
  });

  test("generatePeriods computes a custom (Oct→Sep) annual fiscal year with the correct deadline", () => {
    const periods = generatePeriods("yearly", "2025-10-01", "2026-09-30", "2025-10-01");
    expect(periods).toEqual([{ date_start: "2025-10-01", date_end: "2026-09-30" }]);
    expect(computeDeadline(periods[0].date_end, 19)).toBe("2026-10-19");
  });

  test("generatePeriods enumerates calendar months and quarters across the window", () => {
    expect(generatePeriods("monthly", "2026-01-01", "2026-03-31")).toEqual([
      { date_start: "2026-01-01", date_end: "2026-01-31" },
      { date_start: "2026-02-01", date_end: "2026-02-28" },
      { date_start: "2026-03-01", date_end: "2026-03-31" }
    ]);
    expect(generatePeriods("quarterly", "2026-01-01", "2026-06-30")).toEqual([
      { date_start: "2026-01-01", date_end: "2026-03-31" },
      { date_start: "2026-04-01", date_end: "2026-06-30" }
    ]);
  });

  test("diffExpectedReturns flags matching periods exists:true and missing ones exists:false", () => {
    const expected = [
      { name: "A", date_start: "2026-01-01", date_end: "2026-01-31", deadline: "2026-02-20" },
      { name: "B", date_start: "2026-02-01", date_end: "2026-02-28", deadline: "2026-03-20" }
    ];
    const existing = [{ date_from: "2026-01-01", date_to: "2026-01-31" }];
    const diffed = diffExpectedReturns(expected, existing);
    expect(diffed[0].exists).toBe(true);
    expect(diffed[1].exists).toBe(false);
  });
});
