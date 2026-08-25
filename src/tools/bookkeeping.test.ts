import { afterEach, describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TtlCache } from "../cache";
import { OdooError, callOdoo } from "../odoo";
import { OdooQueue } from "../odoo-queue";
import {
  DOCUMENTS_UNAVAILABLE_WARNING,
  DOCUMENT_SEARCH_FIELDS,
  VISION_MIME_TYPES,
  estimateBase64DecodedBytes,
  normalizeMimetype,
  resolveVisionMimetype,
  sniffImageMimetype,
  SUSPENSE_ACCOUNT_CODES,
  buildOpenItemDomain,
  buildSourceDocumentDomain,
  computeDeadline,
  computeSeverity,
  diffExpectedReturns,
  extractGroupCount,
  generatePeriods,
  isDocumentsUnavailableError,
  isSuspenseAccount,
  normalizePeriodicity,
  normalizeSourceDocument,
  registerBookkeepingTools,
  registerReturnPreviewTools,
  registerSourceDocumentTools, registerReportLineTools,
  resolveOpenItemPredicate } from "./bookkeeping";
import { validatedToolHandler } from "./structured-test-util";

const originalFetch = globalThis.fetch;

function makeQueue() {
  return new OdooQueue(callOdoo, { minDelayMs: 0 });
}

function buildHandler(queue: OdooQueue, cache: TtlCache) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
  registerBookkeepingTools(server, () => props, queue, cache);
  return validatedToolHandler(server, "bookkeeping.get_snapshot");
}

function buildReviewHandler(queue: OdooQueue, cache: TtlCache) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
  registerBookkeepingTools(server, () => props, queue, cache);
  return validatedToolHandler(server, "bookkeeping.review_key_accounts");
}

interface CannedResponse {
  status: number;
  body: unknown;
}

type CannedResolver = CannedResponse | CannedResponse[] | ((body: any, callIndex: number) => CannedResponse);

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

function buildFetchMock(overrides: Record<string, CannedResolver> = {}) {
  const responses: Record<string, CannedResolver> = { ...BASE_RESPONSES, ...overrides };
  const callIndexByKey: Record<string, number> = {};
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
    const resolver = responses[key];
    if (!resolver) {
      return new Response(JSON.stringify({ error: { message: `no canned response for ${key}` } }), { status: 404 });
    }
    const callIndex = callIndexByKey[key] ?? 0;
    callIndexByKey[key] = callIndex + 1;

    let resp: CannedResponse;
    if (typeof resolver === "function") {
      resp = resolver(body, callIndex);
    } else if (Array.isArray(resolver)) {
      resp = resolver[Math.min(callIndex, resolver.length - 1)]!;
    } else {
      resp = resolver;
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

  test("Odoo 19 key_accounts scope uses formatted_read_group for balances", async () => {
    const { fetchMock, calls } = buildFetchMock({
      "account.move.line.read_group": {
        status: 404,
        body: { error: { message: "The method 'account.move.line.read_group' does not exist" } }
      },
      "account.move.line.formatted_read_group": {
        status: 200,
        body: [{ account_id: [500, "Key Account"], "balance:sum": 1000, __count: 5 }]
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
    expect(parsed.warnings.some((w: string) => /balances\) unavailable/.test(w))).toBe(false);
    const balanceRow = parsed.key_accounts.balances.records[0];
    expect(balanceRow.balance).toBe(1000);
    expect(calls.some((c) => c.method === "formatted_read_group")).toBe(true);
    expect(calls.some((c) => c.method === "read_group")).toBe(false);
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

  test("key_accounts scope discloses when open-lines search_read hits its limit", async () => {
    const openLines = Array.from({ length: 50 }, (_, i) => ({
      id: 600 + i,
      account_id: [500, "Key Account"],
      date: "2026-03-01",
      name: `Line ${i}`,
      amount_residual: 1,
      move_id: [700, "MV1"],
      partner_id: [800, "Partner"]
    }));
    const { fetchMock } = buildFetchMock({
      "account.move.line.search_read": { status: 200, body: openLines }
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
    expect(parsed.warnings.some((w: string) => /open lines.*limit of 50/.test(w))).toBe(true);
  });

  test("tax_report scope discloses when account.report search_read hits its limit", async () => {
    const reports = Array.from({ length: 50 }, (_, i) => ({
      id: 100 + i,
      name: `Report ${i}`,
      country_id: [10, "United States"],
      root_report_id: false
    }));
    const { fetchMock } = buildFetchMock({
      "account.report.search_read": { status: 200, body: reports }
    });
    globalThis.fetch = fetchMock;
    const handler = buildHandler(makeQueue(), new TtlCache());

    const result = await handler({
      company: "Acme Corp",
      date_from: "2026-01-01",
      date_to: "2026-03-31",
      scopes: ["tax_report"]
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => /account\.report search_read returned the limit of 50/.test(w))).toBe(true);
  });
});

describe("computeSeverity / isSuspenseAccount", () => {
  test("suspense code with a non-zero balance is attention", () => {
    expect(computeSeverity("471000", 100, 0)).toBe("attention");
    expect(computeSeverity("580000", -0.5, 0)).toBe("attention");
  });

  test("suspense code with open items but zero balance is attention", () => {
    expect(computeSeverity("471000", 0, 3)).toBe("attention");
  });

  test("fully empty account (zero balance, no open items) is ok", () => {
    expect(computeSeverity("471000", 0, 0)).toBe("ok");
    expect(computeSeverity("445670", 0, 0)).toBe("ok");
    expect(computeSeverity("471000", 1e-12, 0)).toBe("ok"); // float noise tolerated
  });

  test("non-suspense account with a balance is info, never attention", () => {
    expect(computeSeverity("445670", 5000, 0)).toBe("info");
    expect(computeSeverity("455100", 0, 7)).toBe("info");
  });

  test("isSuspenseAccount / SUSPENSE_ACCOUNT_CODES", () => {
    expect(isSuspenseAccount("471000")).toBe(true);
    expect(isSuspenseAccount("580000")).toBe(true);
    expect(isSuspenseAccount("445670")).toBe(false);
    expect(SUSPENSE_ACCOUNT_CODES.has("471000")).toBe(true);
    expect(SUSPENSE_ACCOUNT_CODES.has("580000")).toBe(true);
  });
});

describe("bookkeeping.review_key_accounts", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const SUSPENSE_ACCOUNT_OVERRIDE: Record<string, CannedResolver> = {
    "account.account.search_read": {
      status: 200,
      body: [{ id: 500, code: "471000", name: "Suspense", account_type: "asset_current", reconcile: true, company_id: [1, "Acme Corp"] }]
    },
    "account.move.line.read_group": {
      status: 200,
      body: [{ account_id: [500, "Suspense"], balance: 1000, __count: 5 }]
    },
    "account.move.line.search_read": {
      status: 200,
      body: [
        {
          id: 600,
          account_id: [500, "Suspense"],
          date: "2026-03-01",
          name: "Open Line",
          amount_residual: 50,
          move_id: [700, "MV1"],
          partner_id: [800, "Partner"],
          journal_id: [10, "Misc"]
        }
      ]
    }
  };

  function isCountReadGroup(body: any): boolean {
    // formatted_read_group uses `aggregates`; legacy read_group uses `fields`.
    const specs = body?.aggregates ?? body?.fields;
    return Array.isArray(specs) && specs.length === 1 && specs[0] === "__count";
  }

  test("unknown code produces a warning while found accounts are still returned", async () => {
    const { fetchMock } = buildFetchMock(SUSPENSE_ACCOUNT_OVERRIDE);
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000", "999999"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes("999999"))).toBe(true);
    expect(parsed.accounts.length).toBe(1);
    const account = parsed.accounts[0];
    expect(account.code).toBe("471000");
    expect(account.balance).toBe(1000);
    // Authoritative count from read_group __count (5), not the sample length (1).
    expect(account.open_item_count).toBe(5);
    expect(account.top_lines.length).toBe(1);
    expect(account.top_lines_truncated).toBe(true);
    // Suspense + non-zero balance => attention.
    expect(account.severity).toBe("attention");
    // top_lines are normalized objects (many2one -> {id,name}) and include the residual.
    expect(account.top_lines[0].partner_id).toEqual({ id: 800, name: "Partner" });
    expect(account.top_lines[0].move_id).toEqual({ id: 700, name: "MV1" });
    expect(account.top_lines[0].amount_residual).toBe(50);
  });

  test("open lines are grouped by account and capped at 10 per account", async () => {
    const manyLines = Array.from({ length: 12 }, (_, i) => ({
      id: 600 + i,
      account_id: [500, "Suspense"],
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      name: `Open ${i}`,
      amount_residual: i + 1,
      move_id: [700 + i, `MV${i}`],
      partner_id: [800, "Partner"],
      journal_id: [10, "Misc"]
    }));
    const { fetchMock } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      "account.move.line.read_group": (body: any) => {
        if (isCountReadGroup(body)) {
          return { status: 200, body: [{ account_id: [500, "Suspense"], __count: 12 }] };
        }
        return { status: 200, body: [{ account_id: [500, "Suspense"], balance: 1000, __count: 5 }] };
      },
      "account.move.line.search_read": { status: 200, body: manyLines }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const account = parsed.accounts[0];
    expect(account.top_lines.length).toBeLessThanOrEqual(10);
    expect(account.top_lines.length).toBe(10);
    expect(account.open_item_count).toBe(12);
    expect(account.top_lines_truncated).toBe(true);
    expect(account.top_lines.every((l: any) => l.account_id.id === 500)).toBe(true);
  });

  test("company not found returns a plain mcpError", async () => {
    const { fetchMock } = buildFetchMock({ "res.company.search_read": { status: 200, body: [] } });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Nope", date_to: "2026-03-31", account_codes: ["471000"] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Nope");
  });

  test("balances read_group failure yields null amounts and severity unknown (never 0 + ok)", async () => {
    const { fetchMock } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      "account.move.line.read_group": {
        status: 500,
        body: { error: { message: "read_group failed: Access Denied" } }
      },
      "account.move.line.search_count": { status: 200, body: 1 }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes("account.move.line (balances)"))).toBe(true);
    expect(parsed.accounts).toHaveLength(1);
    const account = parsed.accounts[0];
    expect(account.balance).toBeNull();
    expect(account.debit).toBeNull();
    expect(account.credit).toBeNull();
    expect(account.severity).toBe("unknown");
    expect(account.severity).not.toBe("ok");
  });

  test("successful read_group with no lines defaults missing accounts to 0 balance and ok severity", async () => {
    const { fetchMock } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      "account.move.line.read_group": { status: 200, body: [] },
      "account.move.line.search_read": { status: 200, body: [] }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes("account.move.line (balances)"))).toBe(false);
    expect(parsed.accounts).toHaveLength(1);
    const account = parsed.accounts[0];
    expect(account.balance).toBe(0);
    expect(account.debit).toBe(0);
    expect(account.credit).toBe(0);
    expect(account.open_item_count).toBe(0);
    expect(account.severity).toBe("ok");
    expect(account.top_lines_truncated).toBe(false);
  });

  test("issues a bounded number of live Odoo calls once fields_get is cached", async () => {
    const { fetchMock, calls } = buildFetchMock(SUSPENSE_ACCOUNT_OVERRIDE);
    globalThis.fetch = fetchMock;
    const queue = makeQueue();
    const cache = new TtlCache();
    const handler = buildReviewHandler(queue, cache);

    // Warm the fields_get cache.
    await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });

    const before = queue.snapshot();
    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });
    const delta = queue.delta(before);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    // res.company + account.account + balances read_group + counts read_group + open-lines search_read.
    expect(parsed.metadata.odoo_calls).toBe(5);
    expect(delta.odoo_calls).toBe(5);
    // No fields_get on the warm call.
    expect(delta.calls.some((c) => c.method === "fields_get")).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(parsed.metadata.duration_seconds).toEqual(expect.any(Number));
    // The default company carries the multi-company RPC context too (adds a body key, not a call).
    const scopedCalls = calls.filter(
      (c) => (c.model === "account.account" || c.model === "account.move.line") && c.method !== "fields_get"
    );
    expect(scopedCalls.length).toBeGreaterThan(0);
    for (const call of scopedCalls) {
      expect(call.body.context).toEqual({ allowed_company_ids: [1], company_id: 1 });
    }
  });

  const ODOO19_BALANCE_FIELDS: Record<string, CannedResolver> = {
    "account.move.line.fields_get": {
      status: 200,
      body: {
        id: { type: "integer" },
        account_id: { type: "many2one", relation: "account.account" },
        date: { type: "date" },
        name: { type: "char" },
        amount_residual: { type: "monetary" },
        balance: { type: "monetary" },
        debit: { type: "monetary" },
        credit: { type: "monetary" },
        move_id: { type: "many2one", relation: "account.move" },
        partner_id: { type: "many2one", relation: "res.partner" },
        journal_id: { type: "many2one", relation: "account.journal" },
        reconciled: { type: "boolean" }
      }
    }
  };

  const ODOO19_READ_GROUP_MISSING: Record<string, CannedResolver> = {
    "account.move.line.read_group": {
      status: 404,
      body: { error: { message: "The method 'account.move.line.read_group' does not exist" } }
    }
  };

  const ODOO19_FORMATTED_BALANCE: Record<string, CannedResolver> = {
    "account.move.line.formatted_read_group": (body: any) => {
      if (isCountReadGroup(body)) {
        return { status: 200, body: [{ account_id: [500, "Suspense"], __count: 5 }] };
      }
      return {
        status: 200,
        body: [
          {
            account_id: [500, "Suspense"],
            "balance:sum": 1000,
            "debit:sum": 1200,
            "credit:sum": 200,
            __count: 5
          }
        ]
      };
    }
  };

  test("Odoo 19: formatted_read_group populates balances with normalized aggregate keys", async () => {
    const { fetchMock, calls } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      ...ODOO19_BALANCE_FIELDS,
      ...ODOO19_READ_GROUP_MISSING,
      ...ODOO19_FORMATTED_BALANCE
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => /balances\) unavailable/.test(w))).toBe(false);
    const account = parsed.accounts[0];
    expect(account.balance).toBe(1000);
    expect(account.debit).toBe(1200);
    expect(account.credit).toBe(200);

    const formattedCalls = calls.filter((c) => c.model === "account.move.line" && c.method === "formatted_read_group");
    expect(formattedCalls.length).toBe(2);
    const balanceCall = formattedCalls.find((c) => !isCountReadGroup(c.body));
    expect(balanceCall?.body.aggregates).toEqual(["balance:sum", "debit:sum", "credit:sum"]);
    expect(balanceCall?.body.fields).toBeUndefined();
    expect(balanceCall?.body.lazy).toBeUndefined();
    expect(calls.some((c) => c.model === "account.move.line" && c.method === "read_group")).toBe(false);
  });

  test("Odoo 19: capability cache avoids re-probing read_group on second call", async () => {
    const { fetchMock, calls } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      ...ODOO19_BALANCE_FIELDS,
      ...ODOO19_READ_GROUP_MISSING,
      ...ODOO19_FORMATTED_BALANCE
    });
    globalThis.fetch = fetchMock;
    const cache = new TtlCache();
    const handler = buildReviewHandler(makeQueue(), cache);

    await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });
    calls.length = 0;

    await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });

    const formattedCalls = calls.filter((c) => c.method === "formatted_read_group");
    const readGroupCalls = calls.filter((c) => c.method === "read_group");
    expect(formattedCalls.length).toBe(2); // balances + counts
    expect(readGroupCalls.length).toBe(0);
  });

  test("both read_group methods missing yields null balances and severity unknown", async () => {
    const { fetchMock } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      ...ODOO19_READ_GROUP_MISSING,
      "account.move.line.formatted_read_group": {
        status: 404,
        body: { error: { message: "The method 'account.move.line.formatted_read_group' does not exist" } }
      },
      "account.move.line.search_count": { status: 200, body: 0 }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes("account.move.line (balances)"))).toBe(true);
    const account = parsed.accounts[0];
    expect(account.balance).toBeNull();
    expect(account.debit).toBeNull();
    expect(account.credit).toBeNull();
    expect(account.severity).toBe("unknown");
  });

  test("regression: sample of 1 does not under-count open_item_count of 25", async () => {
    const { fetchMock } = buildFetchMock({
      "account.account.search_read": {
        status: 200,
        body: [
          { id: 500, code: "401000", name: "Payable A", account_type: "liability_payable", reconcile: true, company_id: [1, "Acme Corp"] },
          { id: 501, code: "401001", name: "Payable B", account_type: "liability_payable", reconcile: true, company_id: [1, "Acme Corp"] }
        ]
      },
      "account.move.line.read_group": (body: any) => {
        if (isCountReadGroup(body)) {
          return {
            status: 200,
            body: [
              { account_id: [500, "Payable A"], __count: 25 },
              { account_id: [501, "Payable B"], __count: 3 }
            ]
          };
        }
        return {
          status: 200,
          body: [
            { account_id: [500, "Payable A"], balance: 100, __count: 25 },
            { account_id: [501, "Payable B"], balance: 50, __count: 3 }
          ]
        };
      },
      "account.move.line.search_read": {
        status: 200,
        body: [
          {
            id: 600,
            account_id: [500, "Payable A"],
            date: "2026-03-01",
            name: "Only sample line",
            amount_residual: 10,
            move_id: [700, "MV1"],
            partner_id: [800, "Partner"],
            journal_id: [10, "Misc"]
          }
        ]
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["401000", "401001"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const byId = Object.fromEntries(parsed.accounts.map((a: any) => [a.id, a]));
    expect(byId[500].open_item_count).toBe(25);
    expect(byId[501].open_item_count).toBe(3);
    expect(byId[500].top_lines.length).toBe(1);
    expect(byId[500].top_lines_truncated).toBe(true);
  });

  test("global sample limit never appears as open_item_count", async () => {
    const { fetchMock, calls } = buildFetchMock({
      "account.account.search_read": {
        status: 200,
        body: [
          { id: 500, code: "401000", name: "Payable A", account_type: "liability_payable", reconcile: true, company_id: [1, "Acme Corp"] },
          { id: 501, code: "401001", name: "Payable B", account_type: "liability_payable", reconcile: true, company_id: [1, "Acme Corp"] }
        ]
      },
      "account.move.line.read_group": (body: any) => {
        if (isCountReadGroup(body)) {
          return {
            status: 200,
            body: [
              { account_id: [500, "Payable A"], __count: 25 },
              { account_id: [501, "Payable B"], __count: 3 }
            ]
          };
        }
        return {
          status: 200,
          body: [
            { account_id: [500, "Payable A"], balance: 100, __count: 25 },
            { account_id: [501, "Payable B"], balance: 50, __count: 3 }
          ]
        };
      },
      "account.move.line.search_read": {
        status: 200,
        body: [
          {
            id: 600,
            account_id: [500, "Payable A"],
            date: "2026-03-01",
            name: "Only sample line",
            amount_residual: 10,
            move_id: [700, "MV1"],
            partner_id: [800, "Partner"],
            journal_id: [10, "Misc"]
          }
        ]
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["401000", "401001"] });
    const parsed = JSON.parse(result.content[0].text);
    const sampleCall = calls.find(
      (c) => c.model === "account.move.line" && c.method === "search_read" && Array.isArray(c.body.domain?.[0]?.[2])
    );
    expect(sampleCall?.body.limit).toBeDefined();
    const sampleLimit = sampleCall!.body.limit as number;
    for (const account of parsed.accounts) {
      expect(account.open_item_count).not.toBe(sampleLimit);
      expect(account.open_item_count).not.toBe(1);
    }
    expect(parsed.accounts.find((a: any) => a.id === 500).open_item_count).toBe(25);
  });

  test("starvation backfill issues a per-account search_read for missing samples", async () => {
    const { fetchMock, calls } = buildFetchMock({
      "account.account.search_read": {
        status: 200,
        body: [
          { id: 500, code: "401000", name: "Payable A", account_type: "liability_payable", reconcile: true, company_id: [1, "Acme Corp"] },
          { id: 501, code: "401001", name: "Payable B", account_type: "liability_payable", reconcile: true, company_id: [1, "Acme Corp"] }
        ]
      },
      "account.move.line.read_group": (body: any) => {
        if (isCountReadGroup(body)) {
          return {
            status: 200,
            body: [
              { account_id: [500, "Payable A"], __count: 25 },
              { account_id: [501, "Payable B"], __count: 3 }
            ]
          };
        }
        return {
          status: 200,
          body: [
            { account_id: [500, "Payable A"], balance: 100, __count: 25 },
            { account_id: [501, "Payable B"], balance: 50, __count: 3 }
          ]
        };
      },
      "account.move.line.search_read": (body: any) => {
        const accountLeaf = body.domain?.find((d: any) => Array.isArray(d) && d[0] === "account_id");
        if (accountLeaf?.[1] === "=" && accountLeaf?.[2] === 501) {
          return {
            status: 200,
            body: [
              {
                id: 701,
                account_id: [501, "Payable B"],
                date: "2025-01-01",
                name: "Backfilled older payable",
                amount_residual: 30,
                move_id: [801, "MV501"],
                partner_id: [901, "Vendor"],
                journal_id: [10, "Misc"]
              }
            ]
          };
        }
        return {
          status: 200,
          body: [
            {
              id: 600,
              account_id: [500, "Payable A"],
              date: "2026-03-01",
              name: "Newest wins without backfill",
              amount_residual: 10,
              move_id: [700, "MV1"],
              partner_id: [800, "Partner"],
              journal_id: [10, "Misc"]
            }
          ]
        };
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["401000", "401001"] });
    const parsed = JSON.parse(result.content[0].text);
    const acct501 = parsed.accounts.find((a: any) => a.id === 501);
    expect(acct501.open_item_count).toBe(3);
    expect(acct501.top_lines.length).toBe(1);
    expect(acct501.top_lines[0].name).toBe("Backfilled older payable");

    const backfill = calls.find(
      (c) =>
        c.model === "account.move.line" &&
        c.method === "search_read" &&
        c.body.domain?.some((d: any) => Array.isArray(d) && d[0] === "account_id" && d[1] === "=" && d[2] === 501)
    );
    expect(backfill).toBeDefined();
    expect(backfill!.body.context).toEqual({ allowed_company_ids: [1], company_id: 1 });
  });

  test("buildOpenItemDomain / resolveOpenItemPredicate clause order and exclusivity", () => {
    expect(resolveOpenItemPredicate({ amount_residual: { type: "monetary" }, reconciled: { type: "boolean" } } as any)).toBe(
      "amount_residual"
    );
    expect(resolveOpenItemPredicate({ reconciled: { type: "boolean" } } as any)).toBe("reconciled");
    expect(resolveOpenItemPredicate({} as any)).toBe("none");

    const withResidual = buildOpenItemDomain({
      accountIds: [500, 501],
      dateTo: "2026-03-31",
      companyId: 1,
      predicate: "amount_residual"
    });
    expect(withResidual).toEqual([
      ["account_id", "in", [500, 501]],
      ["date", "<=", "2026-03-31"],
      ["parent_state", "=", "posted"],
      ["company_id", "=", 1],
      ["amount_residual", "!=", 0]
    ]);
    expect(withResidual.some((c: any) => c[0] === "reconciled")).toBe(false);

    const withReconciled = buildOpenItemDomain({
      accountIds: 500,
      dateTo: "2026-03-31",
      companyId: 1,
      predicate: "reconciled"
    });
    expect(withReconciled).toEqual([
      ["account_id", "=", 500],
      ["date", "<=", "2026-03-31"],
      ["parent_state", "=", "posted"],
      ["company_id", "=", 1],
      ["reconciled", "=", false]
    ]);

    const none = buildOpenItemDomain({ accountIds: [500], dateTo: "2026-03-31", companyId: 1, predicate: "none" });
    expect(none).toHaveLength(4);
  });

  test("diagnostics.open_item_domain deep-equals the counts call domain", async () => {
    const { fetchMock, calls } = buildFetchMock(SUSPENSE_ACCOUNT_OVERRIDE);
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });
    const parsed = JSON.parse(result.content[0].text);

    const countCall = calls.find(
      (c) => c.model === "account.move.line" && c.method === "read_group" && isCountReadGroup(c.body)
    );
    expect(countCall).toBeDefined();
    expect(parsed.diagnostics.open_item_domain).toEqual(countCall!.body.domain);
    expect(parsed.diagnostics.company_id).toBe(1);
    expect(parsed.diagnostics.date_to).toBe("2026-03-31");
    expect(parsed.diagnostics.account_ids).toEqual([500]);
    expect(parsed.diagnostics.open_item_count_method).toBe("read_group");
    expect(parsed.diagnostics.open_item_predicate).toBe("amount_residual");
    expect(parsed.diagnostics.top_lines_sample_limit).toBe(10);
    expect(parsed.accounts[0].open_item_domain).toEqual(
      buildOpenItemDomain({ accountIds: 500, dateTo: "2026-03-31", companyId: 1, predicate: "amount_residual" })
    );
  });

  test("severity uses the true open_item_count (not the sample size)", async () => {
    expect(computeSeverity("445670", 0, 25)).toBe("info");
    expect(computeSeverity("471000", 0, 25)).toBe("attention");

    const { fetchMock } = buildFetchMock({
      "account.account.search_read": {
        status: 200,
        body: [
          { id: 500, code: "445670", name: "VAT credit", account_type: "asset_current", reconcile: true, company_id: [1, "Acme Corp"] },
          { id: 501, code: "471000", name: "Suspense", account_type: "asset_current", reconcile: true, company_id: [1, "Acme Corp"] }
        ]
      },
      "account.move.line.read_group": (body: any) => {
        if (isCountReadGroup(body)) {
          return {
            status: 200,
            body: [
              { account_id: [500, "VAT credit"], __count: 25 },
              { account_id: [501, "Suspense"], __count: 25 }
            ]
          };
        }
        return {
          status: 200,
          body: [
            { account_id: [500, "VAT credit"], balance: 0, __count: 25 },
            { account_id: [501, "Suspense"], balance: 0, __count: 25 }
          ]
        };
      },
      "account.move.line.search_read": { status: 200, body: [] }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["445670", "471000"] });
    const parsed = JSON.parse(result.content[0].text);
    const byCode = Object.fromEntries(parsed.accounts.map((a: any) => [a.code, a]));
    expect(byCode["445670"].balance).toBe(0);
    expect(byCode["445670"].open_item_count).toBe(25);
    expect(byCode["445670"].severity).toBe("info");
    expect(byCode["471000"].severity).toBe("attention");
  });

  test("count query failure falls back to search_count then null/unknown", async () => {
    const { fetchMock, calls } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      "account.move.line.read_group": (body: any) => {
        if (isCountReadGroup(body)) {
          return { status: 500, body: { error: { message: "count read_group failed" } } };
        }
        return { status: 200, body: [{ account_id: [500, "Suspense"], balance: 0, __count: 0 }] };
      },
      "account.move.line.search_count": { status: 200, body: 7 }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const okResult = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });
    const okParsed = JSON.parse(okResult.content[0].text);
    expect(calls.some((c) => c.model === "account.move.line" && c.method === "search_count")).toBe(true);
    expect(okParsed.diagnostics.open_item_count_method).toBe("search_count");
    expect(okParsed.accounts[0].open_item_count).toBe(7);
    // The fallback replays the published account-scoped domain verbatim and keeps the company context.
    const countCall = calls.find((c) => c.model === "account.move.line" && c.method === "search_count");
    expect(countCall!.body.domain).toEqual(okParsed.accounts[0].open_item_domain);
    expect(countCall!.body.context).toEqual({ allowed_company_ids: [1], company_id: 1 });

    const { fetchMock: failMock } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      "account.move.line.read_group": (body: any) => {
        if (isCountReadGroup(body)) {
          return { status: 500, body: { error: { message: "count read_group failed" } } };
        }
        return { status: 200, body: [{ account_id: [500, "Suspense"], balance: 0, __count: 0 }] };
      },
      "account.move.line.formatted_read_group": {
        status: 500,
        body: { error: { message: "formatted count failed" } }
      },
      "account.move.line.search_count": {
        status: 500,
        body: { error: { message: "search_count failed" } }
      }
    });
    globalThis.fetch = failMock;
    const failResult = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });
    const failParsed = JSON.parse(failResult.content[0].text);
    expect(failParsed.accounts[0].open_item_count).toBeNull();
    expect(failParsed.accounts[0].severity).toBe("unknown");
    expect(failParsed.accounts[0].severity).not.toBe("ok");
    expect(failParsed.accounts[0].open_item_count).not.toBe(0);
    expect(failParsed.warnings.some((w: string) => w.includes("account.move.line (open counts)"))).toBe(true);
    expect(failParsed.diagnostics.open_item_count_method).toBe("unavailable");
  });

  test("Odoo 19 counts use formatted_read_group with __count and extractGroupCount keys", async () => {
    expect(extractGroupCount({ __count: 9 }, "account_id")).toBe(9);
    expect(extractGroupCount({ account_id_count: 4 }, "account_id")).toBe(4);
    expect(extractGroupCount({ count: 2 }, "account_id")).toBe(2);
    expect(extractGroupCount({ account_id: [1, "A"] }, "account_id")).toBeNull();

    const { fetchMock, calls } = buildFetchMock({
      ...SUSPENSE_ACCOUNT_OVERRIDE,
      ...ODOO19_BALANCE_FIELDS,
      ...ODOO19_READ_GROUP_MISSING,
      ...ODOO19_FORMATTED_BALANCE
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: ["471000"] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.accounts[0].open_item_count).toBe(5);
    expect(parsed.diagnostics.open_item_count_method).toBe("read_group");

    const countCall = calls.find(
      (c) => c.model === "account.move.line" && c.method === "formatted_read_group" && isCountReadGroup(c.body)
    );
    expect(countCall).toBeDefined();
    expect(countCall!.body.aggregates).toEqual(["__count"]);
    expect(countCall!.body.lazy).toBeUndefined();
    expect(countCall!.body.fields).toBeUndefined();
    expect(countCall!.body.context).toEqual({ allowed_company_ids: [1], company_id: 1 });
  });

  test("account.account lookup at limit emits an explicit truncation warning", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: 500 + i,
      code: `4${String(i).padStart(5, "0")}`,
      name: `Acct ${i}`,
      account_type: "asset_current",
      reconcile: true,
      company_id: [1, "Acme Corp"]
    }));
    const { fetchMock } = buildFetchMock({
      "account.account.search_read": { status: 200, body: rows },
      "account.move.line.read_group": { status: 200, body: [] },
      "account.move.line.search_read": { status: 200, body: [] }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const codes = rows.map((r) => r.code);
    codes.push("999999"); // 101st requested code → also hits the requested-codes > 100 warning
    const result = await handler({ company: "Acme Corp", date_to: "2026-03-31", account_codes: codes });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => /capped at 100/.test(w))).toBe(true);
    expect(parsed.warnings.some((w: string) => /returned the limit of 100/.test(w))).toBe(true);
  });
});

describe("key accounts multi-company context", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Company 8 is NOT the API user's default company: without allowed_company_ids in the RPC
  // context, Odoo 19 record rules hide these rows before the company_id domain leaf applies.
  const OTHER_COMPANY_ID = 8;
  const EXPECTED_CONTEXT = { allowed_company_ids: [OTHER_COMPANY_ID], company_id: OTHER_COMPANY_ID };

  const OTHER_COMPANY_OVERRIDE: Record<string, CannedResolver> = {
    "res.company.search_read": {
      status: 200,
      body: [
        {
          id: OTHER_COMPANY_ID,
          name: "USL MEDIA",
          country_id: [10, "United States"],
          fiscalyear_lock_date: false,
          tax_lock_date: false,
          sale_lock_date: false,
          purchase_lock_date: false,
          hard_lock_date: false
        }
      ]
    },
    "account.account.search_read": {
      status: 200,
      body: [
        { id: 510, code: "451000", name: "VAT Suspense", account_type: "liability_current", reconcile: true, company_id: [8, "USL MEDIA"] },
        { id: 511, code: "101000", name: "Bank", account_type: "asset_cash", reconcile: true, company_id: [8, "USL MEDIA"] }
      ]
    },
    "account.move.line.read_group": {
      status: 200,
      body: [
        { account_id: [510, "VAT Suspense"], balance: -1200, __count: 4 },
        { account_id: [511, "Bank"], balance: 8400, __count: 9 }
      ]
    },
    "account.move.line.search_read": {
      status: 200,
      body: [
        {
          id: 610,
          account_id: [510, "VAT Suspense"],
          date: "2026-08-01",
          name: "Open VAT",
          amount_residual: 120,
          move_id: [710, "MV10"],
          partner_id: [810, "Partner"]
        },
        {
          id: 611,
          account_id: [511, "Bank"],
          date: "2026-08-01",
          name: "Open Bank",
          amount_residual: 50,
          move_id: [711, "MV11"],
          partner_id: [811, "Partner"]
        }
      ]
    }
  };

  /** Every company-scoped account.account / account.move.line data call carries the RPC context. */
  function expectScopedContext(calls: { model: string; method: string; body: any }[]) {
    const scoped = calls.filter(
      (c) => (c.model === "account.account" || c.model === "account.move.line") && c.method !== "fields_get"
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) {
      expect(call.body.context).toEqual(EXPECTED_CONTEXT);
    }
  }

  test("review of a non-default company returns balances and sends allowed_company_ids", async () => {
    const { fetchMock, calls } = buildFetchMock(OTHER_COMPANY_OVERRIDE);
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "USL MEDIA", date_to: "2026-08-11", account_codes: ["451000", "101000"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes("No account.account record found for code"))).toBe(false);
    const byCode = Object.fromEntries(parsed.accounts.map((a: any) => [a.code, a]));
    expect(byCode["451000"].balance).toBe(-1200);
    expect(byCode["101000"].balance).toBe(8400);

    expectScopedContext(calls);
    const readGroupCall = calls.find((c) => c.model === "account.move.line" && c.method === "read_group");
    expect(readGroupCall?.body.context).toEqual(EXPECTED_CONTEXT);
  });

  test("Odoo 19 formatted_read_group fallback carries the same company context", async () => {
    const { fetchMock, calls } = buildFetchMock({
      ...OTHER_COMPANY_OVERRIDE,
      "account.move.line.read_group": {
        status: 404,
        body: { error: { message: "The method 'account.move.line.read_group' does not exist" } }
      },
      "account.move.line.formatted_read_group": (body: any) => {
        const specs = body?.aggregates ?? body?.fields;
        const isCount = Array.isArray(specs) && specs.length === 1 && specs[0] === "__count";
        if (isCount) {
          return {
            status: 200,
            body: [
              { account_id: [510, "VAT Suspense"], __count: 4 },
              { account_id: [511, "Bank"], __count: 9 }
            ]
          };
        }
        return {
          status: 200,
          body: [
            { account_id: [510, "VAT Suspense"], "balance:sum": -1200, __count: 4 },
            { account_id: [511, "Bank"], "balance:sum": 8400, __count: 9 }
          ]
        };
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "USL MEDIA", date_to: "2026-08-11", account_codes: ["451000", "101000"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.accounts.find((a: any) => a.code === "451000").balance).toBe(-1200);

    const formatted = calls.filter((c) => c.model === "account.move.line" && c.method === "formatted_read_group");
    expect(formatted.length).toBe(2);
    for (const call of formatted) {
      expect(call.body.context).toEqual(EXPECTED_CONTEXT);
    }
    expectScopedContext(calls);
  });

  test("fields_get stays context-free so the model-only metadata cache is preserved", async () => {
    const { fetchMock, calls } = buildFetchMock(OTHER_COMPANY_OVERRIDE);
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    await handler({ company: "USL MEDIA", date_to: "2026-08-11", account_codes: ["451000", "101000"] });

    const fieldsGetCalls = calls.filter((c) => c.method === "fields_get");
    expect(fieldsGetCalls.length).toBeGreaterThan(0);
    for (const call of fieldsGetCalls) {
      expect(call.body.context).toBeUndefined();
    }
  });

  test("a company outside the API user's allowed set surfaces Odoo's ACL refusal verbatim", async () => {
    // Odoo validates allowed_company_ids against res.users.company_ids: an unauthorized company
    // now raises AccessError instead of silently returning zero rows per requested code.
    const { fetchMock } = buildFetchMock({
      ...OTHER_COMPANY_OVERRIDE,
      "account.account.search_read": {
        status: 403,
        body: { error: { message: "Access to unauthorized or invalid companies." } }
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildReviewHandler(makeQueue(), new TtlCache());

    const result = await handler({ company: "USL MEDIA", date_to: "2026-08-11", account_codes: ["451000", "101000"] });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("permission_denied");
    expect(envelope.refusing_layer).toBe("odoo_acl");
    expect(envelope.details).toContain("Access to unauthorized or invalid companies.");
    // Not dressed up as a per-code "not found" warning.
    expect(result.content[0].text).not.toContain("No account.account record found for code");
  });

  test("get_snapshot key_accounts scope resolves a non-default company's accounts", async () => {
    const { fetchMock, calls } = buildFetchMock(OTHER_COMPANY_OVERRIDE);
    globalThis.fetch = fetchMock;
    const handler = buildHandler(makeQueue(), new TtlCache());

    const result = await handler({
      company: "USL MEDIA",
      date_from: "2026-01-01",
      date_to: "2026-08-11",
      scopes: ["key_accounts"],
      key_account_codes: ["451000", "101000"]
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.key_accounts.balances.records.length).toBeGreaterThan(0);
    expect(parsed.warnings.some((w: string) => w.includes("No account.account records found for codes"))).toBe(false);

    expectScopedContext(calls);
    const openLines = calls.find((c) => c.model === "account.move.line" && c.method === "search_read");
    expect(openLines?.body.domain).toContainEqual(["company_id", "=", OTHER_COMPANY_ID]);
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
  return validatedToolHandler(agent, name);
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

describe("attachment vision helpers", () => {
  test("normalizeMimetype lowercases, drops parameters, and folds aliases", () => {
    expect(normalizeMimetype("IMAGE/PNG")).toBe("image/png");
    expect(normalizeMimetype("text/plain; charset=utf-8")).toBe("text/plain");
    expect(normalizeMimetype("image/jpg")).toBe("image/jpeg");
    expect(normalizeMimetype("image/pjpeg")).toBe("image/jpeg");
    expect(normalizeMimetype("image/x-png")).toBe("image/png");
    expect(normalizeMimetype(false)).toBeNull();
    expect(normalizeMimetype("   ")).toBeNull();
    expect(normalizeMimetype(undefined)).toBeNull();
  });

  function b64(bytes: number[]) {
    const padded = [...bytes, ...new Array(Math.max(0, 24 - bytes.length)).fill(0x20)];
    return btoa(String.fromCharCode(...padded));
  }

  test("sniffImageMimetype matches jpeg/png/gif/webp magic bytes", () => {
    expect(sniffImageMimetype(b64([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(sniffImageMimetype(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageMimetype(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(
      sniffImageMimetype(
        b64([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
      )
    ).toBe("image/webp");
  });

  test("sniffImageMimetype returns null for non-images and invalid base64", () => {
    expect(sniffImageMimetype(b64([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
    expect(sniffImageMimetype("!!!not base64!!!")).toBeNull();
    expect(sniffImageMimetype("")).toBeNull();
  });

  test("resolveVisionMimetype trusts declared image types and sniffs only generic ones", () => {
    const jpeg = b64([0xff, 0xd8, 0xff, 0xe0]);
    expect(resolveVisionMimetype("image/JPG", jpeg)).toBe("image/jpeg");
    expect(resolveVisionMimetype("application/octet-stream", jpeg)).toBe("image/jpeg");
    expect(resolveVisionMimetype(false, jpeg)).toBe("image/jpeg");
    // A declared PDF is never sniffed into an image, even with image bytes.
    expect(resolveVisionMimetype("application/pdf", jpeg)).toBeNull();
    expect(resolveVisionMimetype("application/octet-stream", b64([0x25, 0x50, 0x44, 0x46]))).toBeNull();
    expect(VISION_MIME_TYPES.has("image/webp")).toBe(true);
  });

  test("estimateBase64DecodedBytes accounts for padding and whitespace without decoding", () => {
    expect(estimateBase64DecodedBytes("AAAA")).toBe(3);
    expect(estimateBase64DecodedBytes("AAA=")).toBe(2);
    expect(estimateBase64DecodedBytes("AA==")).toBe(1);
    expect(estimateBase64DecodedBytes("AAAA\nAAAA")).toBe(6);
    expect(estimateBase64DecodedBytes("")).toBe(0);
  });
});

describe("attachment tool descriptions route agents to fetch_attachment", () => {
  test("list/search source document descriptions cross-link the fetch tool", () => {
    const agent = makeAgent();
    expect(agent._registeredTools["bookkeeping.list_source_documents"].description).toContain("bookkeeping.fetch_attachment");
    expect(agent._registeredTools["bookkeeping.search_source_documents"].description).toContain("bookkeeping.fetch_attachment");
  });

  test("fetch_attachment description advertises vision and rules out PDF rasterization", () => {
    const agent = makeAgent();
    const description = agent._registeredTools["bookkeeping.fetch_attachment"].description as string;
    expect(description).toContain("image content part");
    expect(description).toContain("rasterize");
    expect(description).toContain("OCR");
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
    expect(result.content.length).toBe(1);
    expect(payload.image_included).toBe(false);
    expect(payload.image_omitted_reason).toBe("url_attachment");
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
    // A PDF is bounded base64 only: no image part, no rasterization, no OCR.
    expect(result.content.length).toBe(1);
    expect(payload.image_included).toBe(false);
    expect(payload.image_omitted_reason).toBe("unsupported_mimetype");
  });

  /** Two-call fetch: metadata read, then the datas read. */
  function attachmentFetchMock(meta: Record<string, unknown>, data: Record<string, unknown>) {
    let callCount = 0;
    return mock(async () => {
      callCount++;
      return jsonResponse([callCount === 1 ? meta : data]);
    });
  }

  /** base64 of the given byte values followed by filler, long enough for the sniffer's 18-byte window. */
  function base64OfBytes(bytes: number[]) {
    const padded = [...bytes, ...new Array(Math.max(0, 24 - bytes.length)).fill(0x20)];
    return btoa(String.fromCharCode(...padded));
  }

  const PNG_BASE64 = base64OfBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const JPEG_BASE64 = base64OfBytes([0xff, 0xd8, 0xff, 0xe0]);

  test("declared PNG under the cap: emits an image content part alongside the JSON text block", async () => {
    const agent = makeAgent();
    globalThis.fetch = attachmentFetchMock(
      { name: "receipt.png", mimetype: "image/png", file_size: 100, type: "binary" },
      { name: "receipt.png", mimetype: "image/png", file_size: 100, datas: PNG_BASE64 }
    );

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 5, max_bytes: 10485760 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse(result.content[0].text);
    expect(payload.image_included).toBe(true);
    expect(payload.image_mimetype).toBe("image/png");
    expect(payload.base64).toBe(PNG_BASE64);
    expect(result.content[1]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
  });

  test("octet-stream JPEG is magic-byte sniffed into an image part", async () => {
    const agent = makeAgent();
    globalThis.fetch = attachmentFetchMock(
      { name: "IMG_0042", mimetype: "application/octet-stream", file_size: 100, type: "binary" },
      { name: "IMG_0042", mimetype: "application/octet-stream", file_size: 100, datas: JPEG_BASE64 }
    );

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 6, max_bytes: 10485760 });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.image_included).toBe(true);
    expect(payload.image_mimetype).toBe("image/jpeg");
    expect(result.content[1]).toEqual({ type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" });
  });

  test("file_size:false with an oversize payload is still refused on the decoded estimate", async () => {
    const agent = makeAgent();
    globalThis.fetch = attachmentFetchMock(
      { name: "mystery.bin", mimetype: false, file_size: false, type: "binary" },
      { name: "mystery.bin", mimetype: false, file_size: false, datas: "A".repeat(4000) }
    );

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 7, max_bytes: 1000 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("1000");
    expect(result.content.length).toBe(1);
  });

  test("wrapped base64: the image part is whitespace-stripped while structured base64 stays verbatim", async () => {
    const agent = makeAgent();
    const wrapped = `${PNG_BASE64.slice(0, 8)}\n${PNG_BASE64.slice(8)}`;
    globalThis.fetch = attachmentFetchMock(
      { name: "wrapped.png", mimetype: "image/png", file_size: 100, type: "binary" },
      { name: "wrapped.png", mimetype: "image/png", file_size: 100, datas: wrapped }
    );

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 8, max_bytes: 10485760 });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.base64).toBe(wrapped);
    expect(result.content[1].data).toBe(PNG_BASE64);
  });

  test("garbage base64 with a generic mimetype does not throw and emits no image part", async () => {
    const agent = makeAgent();
    globalThis.fetch = attachmentFetchMock(
      { name: "broken.bin", mimetype: "application/octet-stream", file_size: 20, type: "binary" },
      { name: "broken.bin", mimetype: "application/octet-stream", file_size: 20, datas: "!!!not base64!!!" }
    );

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 9, max_bytes: 10485760 });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.image_included).toBe(false);
    expect(payload.image_omitted_reason).toBe("unsupported_mimetype");
    expect(result.content.length).toBe(1);
  });

  test("an attachment with no stored datas reports no_content and no base64", async () => {
    const agent = makeAgent();
    globalThis.fetch = attachmentFetchMock(
      { name: "empty.png", mimetype: "image/png", file_size: 0, type: "binary" },
      { name: "empty.png", mimetype: "image/png", file_size: 0, datas: false }
    );

    const handler = getToolHandler(agent, "bookkeeping.fetch_attachment");
    const result = await handler({ attachment_id: 10, max_bytes: 10485760 });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.image_included).toBe(false);
    expect(payload.image_omitted_reason).toBe("no_content");
    expect(payload.base64).toBeUndefined();
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
      recoverable: false,
      refusing_layer: "odoo_acl",
      next_step: "Use an Odoo user with the required access rights, or perform the action in the Odoo UI as that user.",
      odoo_exception: "Access Denied by Odoo"
    });
    expect(result.content[0].text).not.toContain("secret-bookkeeping-key");
    expect(result.content[0].text).not.toContain("Bearer");
  });
});

// ---- Documents repository search tests (card ODOO2232) ----

describe("buildSourceDocumentDomain", () => {
  test("no filters yields an empty domain (whole repository)", () => {
    expect(buildSourceDocumentDomain({})).toEqual([]);
  });

  test("maps every filter onto its documented leaf, implicitly ANDed", () => {
    expect(
      buildSourceDocumentDomain({
        filename: "facture",
        folder_id: 3,
        tag_ids: [7, 8],
        owner_id: 2,
        date_from: "2026-01-01",
        date_to: "2026-03-31 23:59:59",
        res_model: "account.move",
        res_id: 42
      })
    ).toEqual([
      ["name", "ilike", "facture"],
      ["folder_id", "=", 3],
      ["tag_ids", "in", [7, 8]],
      ["owner_id", "=", 2],
      ["create_date", ">=", "2026-01-01"],
      ["create_date", "<=", "2026-03-31 23:59:59"],
      ["res_model", "=", "account.move"],
      ["res_id", "=", 42]
    ]);
  });

  test("empty filename and empty tag list contribute no leaves", () => {
    expect(buildSourceDocumentDomain({ filename: "", tag_ids: [], folder_id: 5 })).toEqual([["folder_id", "=", 5]]);
  });
});

describe("normalizeSourceDocument", () => {
  test("many2one tuples become { id, name }, Odoo false becomes null, tag ids resolve via the lookup", () => {
    const normalized = normalizeSourceDocument(
      {
        id: 11,
        name: "facture.pdf",
        folder_id: [3, "Invoices"],
        tag_ids: [7, 8],
        owner_id: [2, "Mitchell Admin"],
        res_model: "account.move",
        res_id: 42,
        create_date: "2026-01-15 09:00:00",
        write_date: "2026-01-16 10:00:00",
        mimetype: "application/pdf",
        file_size: 51234,
        checksum: "abc123",
        attachment_id: [77, "facture.pdf"]
      },
      new Map([
        [7, "Vendor Bill"],
        [8, "2026"]
      ])
    );

    expect(normalized).toEqual({
      id: 11,
      name: "facture.pdf",
      folder: { id: 3, name: "Invoices" },
      tags: [
        { id: 7, name: "Vendor Bill" },
        { id: 8, name: "2026" }
      ],
      owner: { id: 2, name: "Mitchell Admin" },
      res_model: "account.move",
      res_id: 42,
      create_date: "2026-01-15 09:00:00",
      write_date: "2026-01-16 10:00:00",
      mimetype: "application/pdf",
      file_size: 51234,
      checksum: "abc123",
      attachment: { id: 77, name: "facture.pdf" }
    });
  });

  test("unset relations/scalars sanitize to null and unresolved tags fall back to their id", () => {
    const normalized = normalizeSourceDocument({
      id: 12,
      name: "orphan.txt",
      folder_id: false,
      tag_ids: [9],
      owner_id: false,
      res_model: false,
      res_id: false,
      create_date: false,
      write_date: false,
      mimetype: false,
      file_size: false,
      checksum: false,
      attachment_id: false
    });

    expect(normalized).toEqual({
      id: 12,
      name: "orphan.txt",
      folder: null,
      tags: [{ id: 9, name: "9" }],
      owner: null,
      res_model: null,
      res_id: null,
      create_date: null,
      write_date: null,
      mimetype: null,
      file_size: null,
      checksum: null,
      attachment: null
    });
  });

  test("an Odoo origin adds the document link and, when filed, the linked record's link", () => {
    const linked = normalizeSourceDocument(
      { id: 11, name: "facture.pdf", res_model: "account.move", res_id: 42 },
      new Map(),
      "https://odoo.unstaticlabs.com"
    );
    expect(linked.web_url).toBe("https://odoo.unstaticlabs.com/odoo/documents/11");
    expect(linked.linked_record_web_url).toBe("https://odoo.unstaticlabs.com/odoo/entries/42");

    // Unfiled document: its own link only — never a link to a record it does not point at.
    const unfiled = normalizeSourceDocument(
      { id: 12, name: "orphan.txt", res_model: false, res_id: false },
      new Map(),
      "https://odoo.unstaticlabs.com"
    );
    expect(unfiled.web_url).toBe("https://odoo.unstaticlabs.com/odoo/documents/12");
    expect(unfiled).not.toHaveProperty("linked_record_web_url");
  });
});

describe("isDocumentsUnavailableError", () => {
  function odooError(overrides: Partial<ConstructorParameters<typeof OdooError>[0]>) {
    return new OdooError({
      message: "boom",
      code: "unknown",
      httpStatus: 400,
      model: "documents.document",
      method: "search_read",
      details: "boom",
      ...overrides
    });
  }

  test("true for a missing model or an ACL denial on documents.document", () => {
    expect(isDocumentsUnavailableError(odooError({ code: "model_or_method_not_found", httpStatus: 404 }))).toBe(true);
    expect(isDocumentsUnavailableError(odooError({ code: "permission_denied", httpStatus: 403 }))).toBe(true);
  });

  test("true for message-level missing-model / AccessError phrasing that names Documents", () => {
    expect(isDocumentsUnavailableError(odooError({ details: "Object documents.document doesn't exist" }))).toBe(true);
    expect(isDocumentsUnavailableError(odooError({ details: "Invalid model name 'documents.document'" }))).toBe(true);
    expect(
      isDocumentsUnavailableError(odooError({ details: "AccessError: You are not allowed to access 'Document' records" }))
    ).toBe(true);
    expect(isDocumentsUnavailableError(odooError({ details: "You are not allowed to access 'Documents' records" }))).toBe(true);
  });

  test("false for an unauthorized session: bad credentials must not read as a missing Documents app", () => {
    expect(isDocumentsUnavailableError(odooError({ code: "unauthorized", httpStatus: 401 }))).toBe(false);
    expect(
      isDocumentsUnavailableError(
        odooError({ code: "unauthorized", httpStatus: 401, details: "Access denied to documents.document" })
      )
    ).toBe(false);
  });

  test("false for missing-model / ACL phrasing that does not name the Documents model", () => {
    expect(isDocumentsUnavailableError(odooError({ details: "Object account.return doesn't exist" }))).toBe(false);
    expect(isDocumentsUnavailableError(odooError({ details: "You are not allowed to access 'Journal Entry' records" }))).toBe(
      false
    );
    // A field this Odoo version does not have is a schema mismatch, not a missing app: it must not
    // be swallowed into an empty document list.
    expect(
      isDocumentsUnavailableError(odooError({ details: "Invalid field 'checksum' does not exist on model 'documents.document'" }))
    ).toBe(false);
  });

  test("false when the failing call was against another model entirely", () => {
    expect(
      isDocumentsUnavailableError(
        odooError({ model: "account.move", code: "permission_denied", httpStatus: 403, details: "AccessError" })
      )
    ).toBe(false);
  });

  test("false for transient and caller-fixable failures, and for non-Odoo errors", () => {
    expect(isDocumentsUnavailableError(odooError({ code: "timeout", httpStatus: null }))).toBe(false);
    expect(isDocumentsUnavailableError(odooError({ code: "rate_limited", httpStatus: 429 }))).toBe(false);
    expect(isDocumentsUnavailableError(odooError({ code: "invalid_request", details: "Invalid domain leaf" }))).toBe(false);
    expect(isDocumentsUnavailableError(new Error("Object documents.document doesn't exist"))).toBe(false);
  });
});

describe("bookkeeping.search_source_documents", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends the mapped domain, metadata-only fields, limit and deterministic order", async () => {
    const agent = makeAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse([]);
    });

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ filename: "facture", folder_id: 3, res_model: "account.move", res_id: 42, limit: 25 });

    expect(result.isError).toBeUndefined();
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/documents.document/search_read");
    expect(fetchCalls[0].body.domain).toEqual([
      ["name", "ilike", "facture"],
      ["folder_id", "=", 3],
      ["res_model", "=", "account.move"],
      ["res_id", "=", 42]
    ]);
    expect(fetchCalls[0].body.limit).toBe(25);
    expect(fetchCalls[0].body.order).toBe("create_date desc, id desc");
    expect(fetchCalls[0].body.fields).toEqual(DOCUMENT_SEARCH_FIELDS);
    expect(fetchCalls[0].body.fields).not.toContain("datas");

    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({ documents: [], warnings: [] });
  });

  test("falls back to the default limit of 80 when the caller omits it", async () => {
    const agent = makeAgent();
    const bodies: any[] = [];
    globalThis.fetch = mock(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse([]);
    });

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    await handler({});

    expect(bodies[0].limit).toBe(80);
    expect(bodies[0].domain).toEqual([]);
  });

  test("date_from/date_to bound create_date and normalize the returned rows", async () => {
    const agent = makeAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/documents.tag/read")) return jsonResponse([{ id: 7, name: "Vendor Bill" }]);
      return jsonResponse([
        {
          id: 11,
          name: "facture.pdf",
          folder_id: [3, "Invoices"],
          tag_ids: [7],
          owner_id: [2, "Mitchell Admin"],
          res_model: "account.move",
          res_id: 42,
          create_date: "2026-01-15 09:00:00",
          write_date: "2026-01-16 10:00:00",
          mimetype: "application/pdf",
          file_size: 51234,
          checksum: "abc123",
          attachment_id: [77, "facture.pdf"]
        }
      ]);
    });

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ date_from: "2026-01-01", date_to: "2026-01-31", tag_ids: [7], owner_id: 2, limit: 80 });

    expect(result.isError).toBeUndefined();
    expect(fetchCalls[0].body.domain).toEqual([
      ["tag_ids", "in", [7]],
      ["owner_id", "=", 2],
      ["create_date", ">=", "2026-01-01"],
      ["create_date", "<=", "2026-01-31"]
    ]);
    // Tag names cost exactly one extra batched read, never one per document.
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1].url).toContain("/documents.tag/read");
    expect(fetchCalls[1].body.ids).toEqual([7]);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.documents).toEqual([
      {
        id: 11,
        name: "facture.pdf",
        folder: { id: 3, name: "Invoices" },
        tags: [{ id: 7, name: "Vendor Bill" }],
        owner: { id: 2, name: "Mitchell Admin" },
        res_model: "account.move",
        res_id: 42,
        create_date: "2026-01-15 09:00:00",
        write_date: "2026-01-16 10:00:00",
        mimetype: "application/pdf",
        file_size: 51234,
        checksum: "abc123",
        attachment: { id: 77, name: "facture.pdf" },
        // The document links to its own Documents page, plus the record it is filed against.
        // No move_type on a documents.document row, so the move link degrades to Journal Entries.
        web_url: "http://example.com/odoo/documents/11",
        linked_record_web_url: "http://example.com/odoo/entries/42"
      }
    ]);
    expect(payload.warnings).toEqual([]);
  });

  test("de-duplicates tag ids across documents into a single documents.tag read", async () => {
    const agent = makeAgent();
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/documents.tag/read")) return jsonResponse([{ id: 7, name: "Vendor Bill" }]);
      return jsonResponse([
        { id: 1, name: "a.pdf", tag_ids: [7, 8] },
        { id: 2, name: "b.pdf", tag_ids: [7] }
      ]);
    });

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ limit: 80 });

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1].body.ids).toEqual([7, 8]);

    const payload = JSON.parse(result.content[0].text);
    // Tag 8 was not returned by the read (deleted / unreadable) — reported by id rather than dropped.
    expect(payload.documents[0].tags).toEqual([
      { id: 7, name: "Vendor Bill" },
      { id: 8, name: "8" }
    ]);
    expect(payload.warnings).toEqual([]);
  });

  test("no tag ids means no documents.tag call at all", async () => {
    const agent = makeAgent();
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      fetchCalls.push(url);
      return jsonResponse([{ id: 1, name: "a.pdf", tag_ids: [] }]);
    });

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ limit: 80 });

    expect(fetchCalls.length).toBe(1);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.documents[0].tags).toEqual([]);
  });

  test("a failing documents.tag read is non-fatal: documents still returned with a warning", async () => {
    const agent = makeAgent();
    globalThis.fetch = mock(async (url: string) => {
      if (url.endsWith("/documents.tag/read")) {
        return new Response(JSON.stringify({ error: { message: "tag read exploded" } }), { status: 500 });
      }
      return jsonResponse([{ id: 1, name: "a.pdf", tag_ids: [7] }]);
    });

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ limit: 80 });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.documents[0].tags).toEqual([{ id: 7, name: "7" }]);
    expect(payload.warnings.length).toBe(1);
    expect(payload.warnings[0]).toContain("documents.tag names could not be resolved");
  });

  test("missing Documents module degrades to an empty list plus a warning, not an error", async () => {
    const agent = makeAgent();
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: "Object documents.document doesn't exist" } }), { status: 404 })
    );

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ filename: "facture", limit: 80 });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({ documents: [], warnings: [DOCUMENTS_UNAVAILABLE_WARNING] });
  });

  test("ACL denial degrades the same way and never echoes the API key", async () => {
    const agent = makeAgent();
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: "You are not allowed to access 'Document' records" } }), { status: 403 })
    );

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ folder_id: 3, limit: 80 });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({ documents: [], warnings: [DOCUMENTS_UNAVAILABLE_WARNING] });
    expect(result.content[0].text).not.toContain("secret-bookkeeping-key");
  });

  test("a transient Odoo failure still surfaces as a structured error envelope", async () => {
    const agent = makeAgent();
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ error: { message: "Too many requests" } }), { status: 429 })
    );

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ limit: 80 });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("rate_limited");
    expect(envelope.model).toBe("documents.document");
    expect(envelope.method).toBe("search_read");
    expect(result.content[0].text).not.toContain("secret-bookkeeping-key");
  });

  test("expired credentials surface as an unauthorized error, never as an empty document list", async () => {
    const agent = makeAgent();
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ error: { message: "Access denied" } }), { status: 401 })
    );

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ folder_id: 3, limit: 80 });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("unauthorized");
    expect(result.content[0].text).not.toContain(DOCUMENTS_UNAVAILABLE_WARNING);
    expect(result.content[0].text).not.toContain("secret-bookkeeping-key");
  });

  test("an unknown field on this Odoo version errors out instead of degrading to an empty list", async () => {
    const agent = makeAgent();
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: "Invalid field 'checksum' does not exist on model 'documents.document'" } }), {
          status: 400
        })
    );

    const handler = getToolHandler(agent, "bookkeeping.search_source_documents");
    const result = await handler({ limit: 80 });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("invalid_request");
    expect(result.content[0].text).not.toContain(DOCUMENTS_UNAVAILABLE_WARNING);
  });

  test("is registered read-only and leaves list_source_documents untouched", () => {
    const agent = makeAgent();
    const tool = agent._registeredTools["bookkeeping.search_source_documents"];

    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.openWorldHint).toBe(false);
    expect(agent._registeredTools["bookkeeping.list_source_documents"]).toBeDefined();
    expect(agent._registeredTools["bookkeeping.fetch_attachment"]).toBeDefined();
  });
});

describe("bookkeeping.link_source_document", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseDoc = {
    id: 11,
    name: "facture.pdf",
    folder_id: [3, "Invoices"],
    tag_ids: [] as number[],
    owner_id: [2, "Mitchell Admin"],
    res_model: false as false | string,
    res_id: false as false | number,
    create_date: "2026-01-15 09:00:00",
    write_date: "2026-01-16 10:00:00",
    mimetype: "application/pdf",
    file_size: 51234,
    checksum: "abc123",
    attachment_id: [77, "facture.pdf"]
  };

  const baseArgs = {
    document_id: 11,
    target_model: "account.move" as const,
    target_id: 42,
    context: "filing the scanned invoice against vendor bill 42"
  };

  function mockLinkFetch(opts: {
    preDoc?: Record<string, unknown> | null;
    targetRows?: Array<Record<string, unknown>>;
    targetModel?: string;
    writeResult?: unknown;
    readBack?: Record<string, unknown>;
  }) {
    const targetModel = opts.targetModel ?? "account.move";
    const fetchCalls: { url: string; body: any }[] = [];
    let docReads = 0;
    globalThis.fetch = mock(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      if (url.endsWith("/documents.document/read")) {
        docReads += 1;
        if (docReads === 1) {
          if (opts.preDoc === null) return jsonResponse([]);
          return jsonResponse([opts.preDoc ?? { ...baseDoc }]);
        }
        return jsonResponse([opts.readBack ?? { ...baseDoc, res_model: "account.move", res_id: 42 }]);
      }
      if (url.endsWith(`/${targetModel}/read`)) {
        return jsonResponse(opts.targetRows ?? [{ id: 42 }]);
      }
      if (url.endsWith("/documents.document/write")) return jsonResponse(opts.writeResult ?? true);
      if (url.endsWith("/documents.tag/read")) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    });
    return fetchCalls;
  }

  test("happy path writes exactly res_model/res_id and returns re-readable evidence", async () => {
    const fetchCalls = mockLinkFetch({});

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    expect(result.isError).toBeUndefined();
    const write = fetchCalls.find((c) => c.url.endsWith("/documents.document/write"));
    expect(write).toBeDefined();
    expect(write!.body).toEqual({ ids: [11], vals: { res_model: "account.move", res_id: 42 } });
    expect(Object.keys(write!.body.vals).sort()).toEqual(["res_id", "res_model"]);
    expect(fetchCalls.some((c) => c.url.includes("/ir.attachment/"))).toBe(false);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.changed).toBe(true);
    expect(payload.document.res_model).toBe("account.move");
    expect(payload.document.res_id).toBe(42);
    expect(payload.previous_link).toEqual({ res_model: null, res_id: null });
    expect(payload.metadata.odoo_calls).toBeGreaterThan(0);
  });

  test("both sides come back as clickable links, routed by the target's own type", async () => {
    // The existence read doubles as the route-variant read — move_type here, project_id for tasks.
    const fetchCalls = mockLinkFetch({ targetRows: [{ id: 42, move_type: "in_invoice" }] });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    const targetRead = fetchCalls.find((c) => c.url.endsWith("/account.move/read"));
    expect(targetRead!.body.fields).toEqual(["id", "move_type"]);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.document_web_url).toBe("http://example.com/odoo/documents/11");
    expect(payload.target_web_url).toBe("http://example.com/odoo/vendor-bills/42");
  });

  test("a task target keeps its project route", async () => {
    const fetchCalls = mockLinkFetch({
      targetModel: "project.task",
      targetRows: [{ id: 7, project_id: [4, "Odoo MCP"] }],
      readBack: { ...baseDoc, res_model: "project.task", res_id: 7 }
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler({ ...baseArgs, target_model: "project.task" as const, target_id: 7 });

    const targetRead = fetchCalls.find((c) => c.url.endsWith("/project.task/read"));
    expect(targetRead!.body.fields).toEqual(["id", "project_id"]);
    expect(JSON.parse(result.content[0].text).target_web_url).toBe("http://example.com/odoo/project/4/tasks/7");
  });

  test("project.task target reads that model and writes res_model project.task", async () => {
    const fetchCalls = mockLinkFetch({
      targetModel: "project.task",
      targetRows: [{ id: 7 }],
      readBack: { ...baseDoc, res_model: "project.task", res_id: 7 }
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler({
      document_id: 11,
      target_model: "project.task",
      target_id: 7,
      context: "link scanned brief to task 7"
    });

    expect(result.isError).toBeUndefined();
    expect(fetchCalls.some((c) => c.url.endsWith("/project.task/read"))).toBe(true);
    const write = fetchCalls.find((c) => c.url.endsWith("/documents.document/write"));
    expect(write!.body.vals).toEqual({ res_model: "project.task", res_id: 7 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.document.res_model).toBe("project.task");
    expect(payload.document.res_id).toBe(7);
  });

  test("idempotent when already linked: no write, changed false, warning", async () => {
    const fetchCalls = mockLinkFetch({
      preDoc: { ...baseDoc, res_model: "account.move", res_id: 42 },
      readBack: { ...baseDoc, res_model: "account.move", res_id: 42 }
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    expect(result.isError).toBeUndefined();
    expect(fetchCalls.some((c) => c.url.endsWith("/documents.document/write"))).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.changed).toBe(false);
    expect(payload.warnings.some((w: string) => w.includes("already linked"))).toBe(true);
  });

  test("relink warning names the previous link", async () => {
    const fetchCalls = mockLinkFetch({
      preDoc: { ...baseDoc, res_model: "account.move", res_id: 7 },
      readBack: { ...baseDoc, res_model: "account.move", res_id: 42 }
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    expect(result.isError).toBeUndefined();
    expect(fetchCalls.some((c) => c.url.endsWith("/documents.document/write"))).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.previous_link).toEqual({ res_model: "account.move", res_id: 7 });
    expect(payload.warnings.some((w: string) => w.includes("account.move,7"))).toBe(true);
  });

  test("missing Documents app returns documents_app_unavailable and never writes", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      fetchCalls.push(url);
      return new Response(JSON.stringify({ error: { message: "Object documents.document doesn't exist" } }), {
        status: 404
      });
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("documents_app_unavailable");
    expect(envelope.details).toContain("Documents app");
    expect(envelope.recoverable).toBe(false);
    expect(fetchCalls.some((u) => u.endsWith("/documents.document/write"))).toBe(false);
  });

  test("Documents ACL denial returns the same refusal envelope", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      fetchCalls.push(url);
      return new Response(JSON.stringify({ error: { message: "You are not allowed to access 'Document' records" } }), {
        status: 403
      });
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("documents_app_unavailable");
    expect(envelope.ok).toBeUndefined();
    expect(fetchCalls.some((u) => u.endsWith("/documents.document/write"))).toBe(false);
  });

  test("invalid target model is rejected by schema and by the in-handler guard", async () => {
    const agent = makeAgent();
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      fetchCalls.push(url);
      return jsonResponse([]);
    });

    const tool = agent._registeredTools["bookkeeping.link_source_document"];
    const bad = {
      document_id: 11,
      target_model: "res.partner",
      target_id: 42,
      context: "should not link"
    };
    expect(tool.inputSchema.safeParse(bad).success).toBe(false);
    expect(fetchCalls.length).toBe(0);

    const result = await tool.handler(bad);
    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("write_blocked");
    expect(fetchCalls.length).toBe(0);
  });

  test("invalid target id is rejected by the schema with zero fetch calls", async () => {
    const agent = makeAgent();
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      fetchCalls.push(url);
      return jsonResponse([]);
    });

    const shape = agent._registeredTools["bookkeeping.link_source_document"].inputSchema.shape;
    expect(shape.target_id.safeParse(0).success).toBe(false);
    expect(shape.target_id.safeParse(-1).success).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  test("missing or empty context is rejected by the schema with zero fetch calls", async () => {
    const agent = makeAgent();
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      fetchCalls.push(url);
      return jsonResponse([]);
    });

    const shape = agent._registeredTools["bookkeeping.link_source_document"].inputSchema.shape;
    expect(shape.context.safeParse("").success).toBe(false);
    expect(shape.context.safeParse(undefined).success).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  test("document not found returns document_not_found and never writes", async () => {
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/documents.document/read")) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("document_not_found");
    expect(fetchCalls.some((c) => c.url.endsWith("/documents.document/write"))).toBe(false);
  });

  test("target not found returns target_not_found and never writes", async () => {
    const fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/documents.document/read")) return jsonResponse([{ ...baseDoc }]);
      if (url.endsWith("/account.move/read")) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.error).toBe("target_not_found");
    expect(fetchCalls.some((c) => c.url.endsWith("/documents.document/write"))).toBe(false);
  });

  test("target-side authz surfaces as an ordinary error, not documents_app_unavailable", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.endsWith("/documents.document/read")) return jsonResponse([{ ...baseDoc }]);
      if (url.endsWith("/account.move/read")) {
        return new Response(JSON.stringify({ error: { message: "AccessError: You are not allowed to access 'Journal Entry' records" } }), {
          status: 403
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const handler = getToolHandler(makeAgent(), "bookkeeping.link_source_document");
    const result = await handler(baseArgs);

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.model).toBe("account.move");
    expect(envelope.error).not.toBe("documents_app_unavailable");
  });

  test("registers as a write tool", () => {
    const agent = makeAgent();
    const tool = agent._registeredTools["bookkeeping.link_source_document"];
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.annotations.openWorldHint).toBe(false);
  });
});

// ---- Fiscal-return preview tests (card ODOO1077) ----

function buildPreviewHandler(queue: OdooQueue, cache: TtlCache) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
  registerReturnPreviewTools(server, () => props, queue, cache);
  return validatedToolHandler(server, "bookkeeping.preview_returns");
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

// ---- explain_report_line tests (card ODOO1076) ----

function buildExplainHandler(queue: OdooQueue, cache: TtlCache) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const props = { odooBaseUrl: "http://example.com", odooDb: "test-db", odooApiKey: "secret-key" };
  registerReportLineTools(server, () => props, queue, cache);
  return validatedToolHandler(server, "bookkeeping.explain_report_line");
}

/** Parses `.../json/2/<model>/<method>` + JSON body — the same shape buildFetchMock decodes, for custom routers. */
function parseCall(url: string, init: any): { model: string; method: string; body: any } {
  const marker = "/json/2/";
  const rest = url.slice(url.indexOf(marker) + marker.length);
  const lastSlash = rest.lastIndexOf("/");
  return { model: rest.slice(0, lastSlash), method: rest.slice(lastSlash + 1), body: JSON.parse(init.body) };
}

function findClause(domain: any[], field: string): any[] | undefined {
  return domain.find((c) => Array.isArray(c) && c[0] === field);
}

// A `previous_return_period` external expression: the box_22 carryover trap.
const BOX22_OVERRIDES: Record<string, CannedResponse> = {
  "account.report.search_read": { status: 200, body: [{ id: 100, name: "CA12", country_id: [75, "France"] }] },
  "account.report.line.search_read": {
    status: 200,
    body: [{ id: 200, report_id: [100, "CA12"], code: "box_22", name: "Carryover", parent_id: false, sequence: 1 }]
  },
  "account.report.expression.search_read": {
    status: 200,
    body: [
      {
        id: 300,
        report_line_id: [200, "box_22"],
        label: "_applied_carryover_balance",
        engine: "external",
        formula: "",
        subformula: "",
        date_scope: "previous_return_period"
      }
    ]
  }
};

const EXPLAIN_ARGS = {
  company: "Acme Corp",
  report_name: "CA12",
  line_code: "box_22",
  date_from: "2025-10-01",
  date_to: "2026-09-30"
};


describe("bookkeeping.explain_report_line", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("box_22: external value in the previous_return_period scope lands in included, out-of-scope lands in excluded and is named in the diagnosis", async () => {
    const { fetchMock } = buildFetchMock({
      ...BOX22_OVERRIDES,
      "account.report.external.value.search_read": {
        status: 200,
        body: [
          { id: 400, date: "2025-06-30", value: 1000, target_report_expression_id: [300, "_applied_carryover_balance"], company_id: [1, "Acme Corp"] },
          { id: 401, date: "2024-09-30", value: 500, target_report_expression_id: [300, "_applied_carryover_balance"], company_id: [1, "Acme Corp"] }
        ]
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildExplainHandler(makeQueue(), new TtlCache());

    const result = await handler(EXPLAIN_ARGS);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.line.code).toBe("box_22");
    const expr = parsed.expressions[0];
    expect(expr.included_external_values.map((v: any) => v.id)).toEqual([400]);
    expect(expr.excluded_external_values.map((v: any) => v.id)).toEqual([401]);
    expect(parsed.diagnosis).toContain("1 external value(s) dated within 2024-10-01..2025-09-30");
    expect(parsed.diagnosis).toContain("2024-09-30");
    expect(parsed.diagnosis).toContain("out of scope");
  });

  test("box_22 missing case: an empty external-value query reports 0 in-scope values in the diagnosis", async () => {
    const { fetchMock } = buildFetchMock({
      ...BOX22_OVERRIDES,
      "account.report.external.value.search_read": { status: 200, body: [] }
    });
    globalThis.fetch = fetchMock;
    const handler = buildExplainHandler(makeQueue(), new TtlCache());

    const result = await handler(EXPLAIN_ARGS);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const expr = parsed.expressions[0];
    expect(expr.included_external_values).toEqual([]);
    expect(expr.excluded_external_values).toEqual([]);
    expect(parsed.diagnosis).toContain("0 external value(s) dated within 2024-10-01..2025-09-30");
    expect(parsed.diagnosis).not.toContain("out of scope");
  });

  test("older Odoo: a missing external-value FK field degrades into a warning rather than throwing", async () => {
    const { fetchMock } = buildFetchMock({
      ...BOX22_OVERRIDES,
      "account.report.external.value.fields_get": {
        status: 200,
        body: {
          id: { type: "integer" },
          date: { type: "date" },
          value: { type: "float" },
          company_id: { type: "many2one", relation: "res.company" }
          // both target_report_expression_id and report_expression_id intentionally absent
        }
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildExplainHandler(makeQueue(), new TtlCache());

    const result = await handler(EXPLAIN_ARGS);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes("no known report-expression FK field"))).toBe(true);
    expect(parsed.expressions[0].included_external_values).toBeUndefined();
  });

  test("tax_tags: resolves tag names and attaches a single read_group balance sum", async () => {
    const { fetchMock, calls } = buildFetchMock({
      "account.report.expression.search_read": {
        status: 200,
        body: [
          {
            id: 300,
            report_line_id: [200, "L1"],
            label: "balance",
            engine: "tax_tags",
            formula: "10+11",
            subformula: "",
            date_scope: "l10n_period"
          }
        ]
      },
      "account.account.tag.search_read": {
        status: 200,
        body: [
          { id: 10, name: "+FR95" },
          { id: 11, name: "-FR96" }
        ]
      },
      "account.move.line.read_group": {
        status: 404,
        body: { error: { message: "The method 'account.move.line.read_group' does not exist" } }
      },
      "account.move.line.formatted_read_group": {
        status: 200,
        body: [{ "balance:sum": 1000, __count: 3 }]
      }
    });
    globalThis.fetch = fetchMock;
    const handler = buildExplainHandler(makeQueue(), new TtlCache());

    const result = await handler({ ...EXPLAIN_ARGS, report_name: "Tax Report", line_code: "L1" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const expr = parsed.expressions[0];
    expect(expr.tax_tags).toEqual(["+FR95", "-FR96"]);
    expect(expr.tax_tag_balance).toBe(1000);
    const groupCalls = calls.filter((c) => c.model === "account.move.line" && (c.method === "read_group" || c.method === "formatted_read_group"));
    expect(groupCalls.length).toBe(1);
    expect(groupCalls[0].method).toBe("formatted_read_group");
    expect(groupCalls[0].body.groupby).toEqual([]);
    expect(groupCalls[0].body.aggregates).toEqual(["balance:sum"]);
  });

  test("aggregation: builds a one-level-deep formula_trace listing the referenced line codes", async () => {
    const fetchMock = mock(async (url: string, init: any) => {
      const { model, method, body } = parseCall(url, init);
      const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });

      if (method === "fields_get") return ok(BASE_RESPONSES[`${model}.fields_get`].body);
      if (model === "res.company") return ok([{ id: 1, name: "Acme Corp" }]);
      if (model === "account.report") return ok([{ id: 100, name: "CA12" }]);

      if (model === "account.report.line") {
        const code = findClause(body.domain, "code");
        if (code && code[1] === "=") return ok([{ id: 200, report_id: [100, "CA12"], code: "AGG", name: "Aggregate" }]);
        if (code && code[1] === "in")
          return ok([
            { id: 201, report_id: [100, "CA12"], code: "SUBA", name: "Sub A" },
            { id: 202, report_id: [100, "CA12"], code: "SUBB", name: "Sub B" }
          ]);
        return ok([]);
      }

      if (model === "account.report.expression") {
        const rl = findClause(body.domain, "report_line_id");
        if (rl && rl[1] === "=")
          return ok([
            { id: 300, report_line_id: [200, "AGG"], label: "balance", engine: "aggregation", formula: "SUBA.balance + SUBB.balance", subformula: "", date_scope: "l10n_period" }
          ]);
        return ok([
          { id: 301, report_line_id: [201, "SUBA"], label: "balance", engine: "tax_tags", formula: "", subformula: "", date_scope: "l10n_period" },
          { id: 302, report_line_id: [202, "SUBB"], label: "balance", engine: "tax_tags", formula: "", subformula: "", date_scope: "l10n_period" }
        ]);
      }

      return new Response(JSON.stringify({ error: { message: `unexpected ${model}.${method}` } }), { status: 404 });
    });
    globalThis.fetch = fetchMock;
    const handler = buildExplainHandler(makeQueue(), new TtlCache());

    const result = await handler({ ...EXPLAIN_ARGS, line_code: "AGG" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const codes = parsed.formula_trace.map((t: any) => t.code).sort();
    expect(codes).toEqual(["SUBA", "SUBB"]);
    for (const trace of parsed.formula_trace) {
      expect(trace.expressions.length).toBeGreaterThan(0);
      // one level deep: trace entries carry expressions, not nested traces
      expect(trace.formula_trace).toBeUndefined();
    }
    expect(parsed.diagnosis).toContain("SUBA");
    expect(parsed.diagnosis).toContain("SUBB");
  });

  test("unknown line_code returns an mcpError listing the report's available codes", async () => {
    const fetchMock = mock(async (url: string, init: any) => {
      const { model, method, body } = parseCall(url, init);
      const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });

      if (method === "fields_get") return ok(BASE_RESPONSES[`${model}.fields_get`].body);
      if (model === "res.company") return ok([{ id: 1, name: "Acme Corp" }]);
      if (model === "account.report") return ok([{ id: 100, name: "CA12" }]);
      if (model === "account.report.line") {
        const code = findClause(body.domain, "code");
        if (code) return ok([]); // the specific code lookup misses
        return ok([
          { id: 200, report_id: [100, "CA12"], code: "box_20", name: "Line 20" },
          { id: 201, report_id: [100, "CA12"], code: "box_22", name: "Line 22" }
        ]);
      }
      return new Response(JSON.stringify({ error: { message: `unexpected ${model}.${method}` } }), { status: 404 });
    });
    globalThis.fetch = fetchMock;
    const handler = buildExplainHandler(makeQueue(), new TtlCache());

    const result = await handler({ ...EXPLAIN_ARGS, line_code: "does_not_exist" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does_not_exist");
    expect(result.content[0].text).toContain("box_20");
    expect(result.content[0].text).toContain("box_22");
  });

  test("unknown company / report short-circuit with a plain mcpError", async () => {
    const { fetchMock } = buildFetchMock({ "res.company.search_read": { status: 200, body: [] } });
    globalThis.fetch = fetchMock;
    const handler = buildExplainHandler(makeQueue(), new TtlCache());

    const result = await handler(EXPLAIN_ARGS);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Company not found");
  });
});
