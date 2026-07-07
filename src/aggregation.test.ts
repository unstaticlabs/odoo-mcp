import { mock, describe, test, expect, afterEach } from "bun:test";

mock.module("agents/mcp", () => {
  return {
    McpAgent: class McpAgentBase {
      static serve(_path: string, _opts: unknown) {
        return {
          fetch: mock((_req: Request, _env: unknown, ctx: { props?: unknown }) =>
            Promise.resolve(new Response(JSON.stringify({ props: ctx.props }), { status: 200 }))
          )
        };
      }
    }
  };
});
mock.module("agents", () => ({}));
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));

import {
  parseGroupbyToken,
  parseAggregateToken,
  validateAggregationRequest,
  bucketDateValue,
  groupRecordsInMemory,
  aggregateRecords
} from "./aggregation";
import { OdooError } from "./odoo";
import { OdooQueue, callOdoo } from "./index";
import { TtlCache } from "./cache";
import type { CachedFieldMeta } from "./cache";

const originalFetch = globalThis.fetch;

function makeQueue() {
  return new OdooQueue(callOdoo, { minDelayMs: 0 });
}

const taskFieldsMeta: Record<string, CachedFieldMeta> = {
  id: { type: "integer", string: "ID" },
  stage_id: { type: "many2one", string: "Stage", relation: "project.task.type" },
  state: { type: "selection", string: "State", selection: [["open", "Open"], ["done", "Done"]] },
  amount: { type: "float", string: "Amount" },
  date_deadline: { type: "date", string: "Deadline" },
  create_date: { type: "datetime", string: "Created" },
  description: { type: "text", string: "Description" },
  tag_ids: { type: "many2many", string: "Tags", relation: "project.tags" }
};

describe("parseGroupbyToken", () => {
  test("bare field", () => {
    expect(parseGroupbyToken("stage_id")).toEqual({ field: "stage_id" });
  });

  test("date interval", () => {
    expect(parseGroupbyToken("invoice_date:month")).toEqual({ field: "invoice_date", interval: "month" });
  });

  test("rejects empty field", () => {
    expect(parseGroupbyToken(":month")).toEqual({ error: expect.stringContaining("empty") });
  });

  test("rejects unknown interval", () => {
    expect(parseGroupbyToken("date:fortnight")).toEqual({ error: expect.stringContaining("unknown date interval") });
  });
});

describe("parseAggregateToken", () => {
  test("__count", () => {
    expect(parseAggregateToken("__count")).toEqual({ kind: "count" });
  });

  test("sum", () => {
    expect(parseAggregateToken("amount_total:sum")).toEqual({ kind: "sum", field: "amount_total" });
  });

  test("native-only operators", () => {
    expect(parseAggregateToken("amount:avg").native_only).toBe(true);
    expect(parseAggregateToken("amount:min").native_only).toBe(true);
    expect(parseAggregateToken("id:count").native_only).toBe(true);
  });
});

describe("validateAggregationRequest", () => {
  test("unknown groupby field", () => {
    const result = validateAggregationRequest(taskFieldsMeta, ["missing_field"], ["__count"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnosis).toBe("invalid_groupby");
    }
  });

  test("non-groupable type", () => {
    const result = validateAggregationRequest(taskFieldsMeta, ["description"], ["__count"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnosis).toBe("invalid_groupby");
  });

  test("date interval on char-like field rejected via type", () => {
    const meta = { name: { type: "char", string: "Name" } };
    const result = validateAggregationRequest(meta, ["name:month"], ["__count"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("date/datetime");
  });

  test("empty fields meta", () => {
    const result = validateAggregationRequest({}, ["stage_id"], ["__count"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnosis).toBe("unsupported_model");
  });

  test("sum on non-numeric field", () => {
    const result = validateAggregationRequest(taskFieldsMeta, ["stage_id"], ["stage_id:sum"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnosis).toBe("unsupported_aggregate");
  });

  test("valid request", () => {
    const result = validateAggregationRequest(taskFieldsMeta, ["stage_id"], ["__count", "amount:sum"]);
    expect(result.ok).toBe(true);
  });
});

describe("groupRecordsInMemory", () => {
  test("many2one count", () => {
    const rows = [
      { id: 1, stage_id: [10, "Todo"] },
      { id: 2, stage_id: [10, "Todo"] },
      { id: 3, stage_id: [20, "Done"] }
    ];
    const groups = groupRecordsInMemory(
      rows,
      taskFieldsMeta,
      [{ field: "stage_id" }],
      [{ kind: "count" }]
    );
    expect(groups).toHaveLength(2);
    const todo = groups.find((g) => (g.stage_id as number[])[0] === 10);
    expect(todo?.stage_id_count).toBe(2);
    const done = groups.find((g) => (g.stage_id as number[])[0] === 20);
    expect(done?.stage_id_count).toBe(1);
  });

  test("selection count", () => {
    const rows = [
      { id: 1, state: "open" },
      { id: 2, state: "open" },
      { id: 3, state: "done" }
    ];
    const groups = groupRecordsInMemory(rows, taskFieldsMeta, [{ field: "state" }], [{ kind: "count" }]);
    const open = groups.find((g) => g.state === "open");
    expect(open?.state_count).toBe(2);
  });

  test("date month bucket + sum", () => {
    const rows = [
      { id: 1, date_deadline: "2024-01-15", amount: 10 },
      { id: 2, date_deadline: "2024-01-20", amount: 5 },
      { id: 3, date_deadline: "2024-02-01", amount: 7 }
    ];
    const groups = groupRecordsInMemory(
      rows,
      taskFieldsMeta,
      [{ field: "date_deadline", interval: "month" }],
      [{ kind: "count" }, { kind: "sum", field: "amount" }]
    );
    const jan = groups.find((g) => g["date_deadline:month"] === "2024-01");
    expect(jan?.date_deadline_count).toBe(2);
    expect(jan?.amount_sum).toBe(15);
  });

  test("datetime month bucket groups Odoo space-separated timestamps", () => {
    const rows = [
      { id: 1, create_date: "2026-07-02 10:00:00" },
      { id: 2, create_date: "2026-07-15 14:30:00" },
      { id: 3, create_date: "2026-06-28 08:00:00" }
    ];
    const groups = groupRecordsInMemory(
      rows,
      taskFieldsMeta,
      [{ field: "create_date", interval: "month" }],
      [{ kind: "count" }]
    );
    expect(groups).toHaveLength(2);
    const jul = groups.find((g) => g["create_date:month"] === "2026-07");
    expect(jul?.create_date_count).toBe(2);
    const jun = groups.find((g) => g["create_date:month"] === "2026-06");
    expect(jun?.create_date_count).toBe(1);
  });
});

describe("bucketDateValue", () => {
  test("date-only string", () => {
    expect(bucketDateValue("2024-01-15", "month")).toBe("2024-01");
    expect(bucketDateValue("2024-01-15", "day")).toBe("2024-01-15");
  });

  test("Odoo space-separated datetime", () => {
    expect(bucketDateValue("2026-07-02 10:00:00", "month")).toBe("2026-07");
    expect(bucketDateValue("2026-07-15 14:30:00", "month")).toBe("2026-07");
    expect(bucketDateValue("2026-06-28 08:00:00", "month")).toBe("2026-06");
  });

  test("ISO datetime with T", () => {
    expect(bucketDateValue("2026-07-02T10:00:00Z", "month")).toBe("2026-07");
  });

  test("null and false", () => {
    expect(bucketDateValue(null, "month")).toBe("false");
    expect(bucketDateValue(false, "month")).toBe("false");
  });
});

describe("aggregateRecords integration", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const conn = { url: "http://example.com", db: "test-db", apiKey: "secret-agg-key-xyz" };

  function fieldsGetResponse(meta: Record<string, CachedFieldMeta>) {
    return new Response(JSON.stringify({ result: meta }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  test("native success on project.task", async () => {
    const fetchMock = mock(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) {
        return new Response(
          JSON.stringify({ result: [{ stage_id: [10, "Todo"], stage_id_count: 3 }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const result = await aggregateRecords(makeQueue(), new TtlCache(), conn, {
      model: "project.task",
      domain: [],
      groupby: ["stage_id"],
      aggregates: ["__count"],
      lazy: true
    });

    expect(result.metadata.fallback).toBe(false);
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  test("native success on project.project", async () => {
    const projectMeta: Record<string, CachedFieldMeta> = {
      stage_id: { type: "many2one", string: "Stage", relation: "project.project.stage" }
    };
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(projectMeta);
      if (url.includes("/read_group")) {
        return new Response(
          JSON.stringify({ result: [{ stage_id: [1, "Planning"], stage_id_count: 5 }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const result = await aggregateRecords(makeQueue(), new TtlCache(), conn, {
      model: "project.project",
      domain: [],
      groupby: ["stage_id"],
      aggregates: ["__count"],
      lazy: true
    });

    expect(result.metadata.fallback).toBe(false);
    expect(result.groups[0].stage_id_count).toBe(5);
  });

  test("native success on res.partner", async () => {
    const partnerMeta: Record<string, CachedFieldMeta> = {
      active: { type: "boolean", string: "Active" }
    };
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(partnerMeta);
      if (url.includes("/read_group")) {
        return new Response(
          JSON.stringify({ result: [{ active: true, active_count: 12 }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const result = await aggregateRecords(makeQueue(), new TtlCache(), conn, {
      model: "res.partner",
      domain: [],
      groupby: ["active"],
      aggregates: ["__count"],
      lazy: true
    });

    expect(result.metadata.fallback).toBe(false);
    expect(result.groups[0].active_count).toBe(12);
  });

  test("native success on account.move with month + sum", async () => {
    const moveMeta: Record<string, CachedFieldMeta> = {
      invoice_date: { type: "date", string: "Invoice Date" },
      amount_total: { type: "monetary", string: "Total" }
    };
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(moveMeta);
      if (url.includes("/read_group")) {
        return new Response(
          JSON.stringify({
            result: [{ "invoice_date:month": "2024-03", amount_total_sum: 1500 }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const result = await aggregateRecords(makeQueue(), new TtlCache(), conn, {
      model: "account.move",
      domain: [["move_type", "=", "in_invoice"]],
      groupby: ["invoice_date:month"],
      aggregates: ["amount_total:sum"],
      lazy: true
    });

    expect(result.metadata.fallback).toBe(false);
    expect(result.groups[0]["invoice_date:month"]).toBe("2024-03");
  });

  test("fallback when read_group 404", async () => {
    const fetchMock = mock(async (url: string, init: RequestInit) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) return new Response("not found", { status: 404 });
      if (url.includes("/search_count")) {
        return new Response(JSON.stringify({ result: 2 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/search_read")) {
        return new Response(
          JSON.stringify({
            result: [
              { id: 1, stage_id: [10, "Todo"] },
              { id: 2, stage_id: [10, "Todo"] }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const result = await aggregateRecords(makeQueue(), new TtlCache(), conn, {
      model: "custom.model",
      domain: [],
      groupby: ["stage_id"],
      aggregates: ["__count"],
      lazy: true
    });

    expect(result.metadata.fallback).toBe(true);
    expect(result.metadata.records_scanned).toBe(2);
    expect(result.metadata.total_matching).toBe(2);
    expect(result.warnings.some((w) => w.includes("fallback"))).toBe(true);
    expect(result.groups[0].stage_id_count).toBe(2);
    expect(result.groups[0].stage_id).toEqual({ id: 10, name: "Todo" });
  });

  test("invalid groupby does not call search_read", async () => {
    let searchReadCalled = false;
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/search_read")) {
        searchReadCalled = true;
        return new Response(JSON.stringify({ result: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "project.task",
        domain: [],
        groupby: ["nonexistent"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toMatchObject({ diagnosis: "invalid_groupby" });

    expect(searchReadCalled).toBe(false);
  });

  test("unsupported model on fields_get 404", async () => {
    const fetchMock = mock(async () => new Response("not found", { status: 404 }));
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "ghost.model",
        domain: [],
        groupby: ["name"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toMatchObject({ diagnosis: "unsupported_model" });
  });

  test("permission denied on fields_get 403", async () => {
    const fetchMock = mock(async () => new Response("forbidden", { status: 403 }));
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "project.task",
        domain: [],
        groupby: ["stage_id"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toMatchObject({ diagnosis: "permission_denied" });
  });

  test("transient OdooError on fields_get is rethrown unchanged", async () => {
    const fetchMock = mock(async () => new Response("rate limited", { status: 429 }));
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "project.task",
        domain: [],
        groupby: ["stage_id"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  test("fallback search_read 404 maps to unsupported_model", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) return new Response("not found", { status: 404 });
      if (url.includes("/search_count")) {
        return new Response(JSON.stringify({ result: 2 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/search_read")) return new Response("not found", { status: 404 });
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "custom.model",
        domain: [],
        groupby: ["stage_id"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toMatchObject({ diagnosis: "unsupported_model" });
  });

  test("permission denied on read_group 403 — no fallback", async () => {
    let searchCountCalled = false;
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) return new Response("forbidden", { status: 403 });
      if (url.includes("/search_count")) {
        searchCountCalled = true;
        return new Response(JSON.stringify({ result: 0 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "project.task",
        domain: [],
        groupby: ["stage_id"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toMatchObject({ diagnosis: "permission_denied" });

    expect(searchCountCalled).toBe(false);
  });

  test("unauthorized 401 — no fallback", async () => {
    let afterFieldsGet = false;
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      afterFieldsGet = true;
      return new Response("unauthorized", { status: 401 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "project.task",
        domain: [],
        groupby: ["stage_id"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toMatchObject({ diagnosis: "permission_denied" });

    expect(afterFieldsGet).toBe(true);
  });

  test("unsupported aggregate in fallback (:avg)", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) return new Response("not found", { status: 404 });
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "custom.model",
        domain: [],
        groupby: ["stage_id"],
        aggregates: ["amount:avg"],
        lazy: true
      })
    ).rejects.toMatchObject({ diagnosis: "unsupported_aggregate" });
  });

  test("has_more when total exceeds limit", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) return new Response("not found", { status: 404 });
      if (url.includes("/search_count")) {
        return new Response(JSON.stringify({ result: 250 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/search_read")) {
        const rows = Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          stage_id: [10, "Todo"]
        }));
        return new Response(JSON.stringify({ result: rows }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const result = await aggregateRecords(makeQueue(), new TtlCache(), conn, {
      model: "custom.model",
      domain: [],
      groupby: ["stage_id"],
      aggregates: ["__count"],
      lazy: true,
      limit: 100,
      offset: 0
    });

    expect(result.metadata.has_more).toBe(true);
    expect(result.metadata.total_matching).toBe(250);
    expect(result.warnings.some((w) => w.includes("paginate"))).toBe(true);
    expect(result.groups[0].stage_id_count).toBe(100);
  });

  test("pagination offset=100", async () => {
    const fetchMock = mock(async (url: string, init: RequestInit) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) return new Response("not found", { status: 404 });
      if (url.includes("/search_count")) {
        return new Response(JSON.stringify({ result: 150 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/search_read")) {
        const body = JSON.parse(init.body as string);
        expect(body.offset).toBe(100);
        const rows = Array.from({ length: 50 }, (_, i) => ({
          id: i + 101,
          stage_id: [20, "Done"]
        }));
        return new Response(JSON.stringify({ result: rows }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    const result = await aggregateRecords(makeQueue(), new TtlCache(), conn, {
      model: "custom.model",
      domain: [],
      groupby: ["stage_id"],
      aggregates: ["__count"],
      lazy: true,
      limit: 100,
      offset: 100
    });

    expect(result.metadata.records_scanned).toBe(50);
    expect(result.metadata.has_more).toBe(false);
    expect(result.groups[0].stage_id_count).toBe(50);
  });

  test("multi-groupby fallback refused", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) return new Response("not found", { status: 404 });
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "custom.model",
        domain: [],
        groupby: ["stage_id", "state"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toMatchObject({ diagnosis: "unsupported_aggregate" });
  });

  test("API key not leaked in error envelope", async () => {
    const { validatedToolHandler } = await import("./tools/structured-test-util");
    const { McpAgent } = await import("./index");

    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      return new Response("forbidden", { status: 403 });
    });
    globalThis.fetch = fetchMock;

    const AgentCtor = McpAgent as any;
    const agent = new AgentCtor();
    agent.odooQueue = makeQueue();
    agent.props = {
      odooBaseUrl: "http://example.com",
      odooDb: "test-db",
      odooApiKey: "secret-agg-key-xyz"
    };
    await agent.init();

    const handler = validatedToolHandler(agent.server, "aggregate_records");
    const result = await handler({
      model: "project.task",
      domain: [],
      groupby: ["stage_id"],
      aggregates: ["__count"],
      lazy: true
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).not.toContain("secret-agg-key-xyz");
    expect(text).not.toContain("Bearer");
    const envelope = JSON.parse(text);
    expect(envelope.diagnosis).toBe("permission_denied");
  });

  test("transient OdooError is rethrown unchanged", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/fields_get")) return fieldsGetResponse(taskFieldsMeta);
      if (url.includes("/read_group")) return new Response("rate limited", { status: 429 });
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;

    await expect(
      aggregateRecords(makeQueue(), new TtlCache(), conn, {
        model: "project.task",
        domain: [],
        groupby: ["stage_id"],
        aggregates: ["__count"],
        lazy: true
      })
    ).rejects.toBeInstanceOf(OdooError);
  });
});
