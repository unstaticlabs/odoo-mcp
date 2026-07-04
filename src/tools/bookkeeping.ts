import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type CachedFieldMeta, type TtlCache, getFieldsCached } from "../cache";
import { normalizeRecord, normalizeRecords } from "../normalizer";
import { OdooError, type OdooConnection } from "../odoo";
import type { OdooQueue } from "../odoo-queue";
import type { Props } from "../server";
import { mcpError, mcpErrorFromException, requireConnection } from "./shared";

type FieldsMeta = Record<string, CachedFieldMeta>;

const LOCK_FIELD_CANDIDATES = ["fiscalyear_lock_date", "tax_lock_date", "sale_lock_date", "purchase_lock_date", "hard_lock_date"];
const EXTERNAL_VALUE_FK_CANDIDATES = ["target_report_expression_id", "report_expression_id"];
const ACCOUNT_REPORT_FIELD_CANDIDATES = ["id", "name", "country_id", "root_report_id"];
const ACCOUNT_REPORT_LINE_FIELD_CANDIDATES = ["id", "report_id", "code", "name", "parent_id", "sequence", "hierarchy_level"];
const ACCOUNT_REPORT_EXPRESSION_FIELD_CANDIDATES = ["id", "report_line_id", "label", "engine", "formula", "subformula", "date_scope"];
const ACCOUNT_RETURN_TYPE_FIELD_CANDIDATES = [
  "id",
  "name",
  "periodicity",
  "deadline_days",
  "deadline_months",
  "deadline_start_date",
  "deadline_end_type",
  "report_id"
];
const ACCOUNT_RETURN_FIELD_CANDIDATES = ["id", "name", "company_id", "date_from", "date_to", "state", "type_id"];
const ACCOUNT_ACCOUNT_FIELD_CANDIDATES = ["id", "code", "name"];
const ACCOUNT_ACCOUNT_COMPANY_FIELD_CANDIDATES = ["company_id", "company_ids"];
const MOVE_LINE_OPEN_FIELD_CANDIDATES = ["id", "account_id", "date", "name", "amount_residual", "move_id", "partner_id"];

/** Exported for unit testing. Intersects candidate field names with a model's fields_get result. */
export function pickExistingFields(candidates: string[], fieldsMeta: Record<string, unknown>): string[] {
  return candidates.filter((name) => name in fieldsMeta);
}

/** Exported for unit testing. `date` (an Odoo date/datetime string) falls within [dateFrom, dateTo] (both YYYY-MM-DD). */
export function isInPeriod(date: unknown, dateFrom: string, dateTo: string): boolean {
  if (typeof date !== "string" || !date) return false;
  const day = date.slice(0, 10);
  return day >= dateFrom && day <= dateTo;
}

/** Exported for unit testing. Groups normalized account.move.line rows by their (already-normalized) account_id.id. */
export function groupByAccountId(rows: Record<string, unknown>[]): Record<string, unknown[]> {
  const groups: Record<string, unknown[]> = {};
  for (const row of rows) {
    const accountId = row.account_id as { id: number } | null;
    const key = accountId ? String(accountId.id) : "unknown";
    (groups[key] ??= []).push(row);
  }
  return groups;
}

function warnOn(model: string, err: unknown): string {
  if (err instanceof OdooError) return `${model} unavailable: ${err.details}`;
  return `${model} unavailable: ${err instanceof Error ? err.message : String(err)}`;
}

export interface RecordContainer {
  model: string;
  records: unknown[];
}

/** Exported for unit testing. Wraps a normalized record list with its source model name for provenance. */
export function withModel(model: string, records: unknown[]): RecordContainer {
  return { model, records };
}

interface TaxReportScopeResult {
  output: { reports: RecordContainer; lines: RecordContainer; expressions: RecordContainer };
  expressionIds: number[];
  warnings: string[];
}

async function buildTaxReportScope(
  cache: TtlCache,
  queue: OdooQueue,
  conn: OdooConnection,
  countryId: number | null
): Promise<TaxReportScopeResult> {
  const warnings: string[] = [];

  let reports = withModel("account.report", []);
  let reportIds: number[] = [];
  try {
    const fieldsMeta = await getFieldsCached(cache, queue, conn, "account.report");
    const fields = pickExistingFields(ACCOUNT_REPORT_FIELD_CANDIDATES, fieldsMeta);
    const rows = (await queue.enqueue(conn, "account.report", "search_read", {
      domain: countryId != null ? [["country_id", "=", countryId]] : [],
      fields,
      limit: 50
    })) as Record<string, unknown>[];
    reports = withModel("account.report", normalizeRecords(rows, fieldsMeta));
    reportIds = rows.map((row) => row.id as number);
  } catch (err) {
    warnings.push(warnOn("account.report", err));
  }

  let lines = withModel("account.report.line", []);
  let lineIds: number[] = [];
  if (reportIds.length > 0) {
    try {
      const fieldsMeta = await getFieldsCached(cache, queue, conn, "account.report.line");
      const fields = pickExistingFields(ACCOUNT_REPORT_LINE_FIELD_CANDIDATES, fieldsMeta);
      const rows = (await queue.enqueue(conn, "account.report.line", "search_read", {
        domain: [["report_id", "in", reportIds]],
        fields,
        limit: 500
      })) as Record<string, unknown>[];
      lines = withModel("account.report.line", normalizeRecords(rows, fieldsMeta));
      lineIds = rows.map((row) => row.id as number);
    } catch (err) {
      warnings.push(warnOn("account.report.line", err));
    }
  }

  let expressions = withModel("account.report.expression", []);
  let expressionIds: number[] = [];
  if (lineIds.length > 0) {
    try {
      const fieldsMeta = await getFieldsCached(cache, queue, conn, "account.report.expression");
      const fields = pickExistingFields(ACCOUNT_REPORT_EXPRESSION_FIELD_CANDIDATES, fieldsMeta);
      const rows = (await queue.enqueue(conn, "account.report.expression", "search_read", {
        domain: [["report_line_id", "in", lineIds]],
        fields,
        limit: 1000
      })) as Record<string, unknown>[];
      expressions = withModel("account.report.expression", normalizeRecords(rows, fieldsMeta));
      expressionIds = rows.map((row) => row.id as number);
    } catch (err) {
      warnings.push(warnOn("account.report.expression", err));
    }
  }

  return { output: { reports, lines, expressions }, expressionIds, warnings };
}

interface ExternalValuesScopeResult {
  output: { values: RecordContainer };
  warnings: string[];
}

async function buildExternalValuesScope(
  cache: TtlCache,
  queue: OdooQueue,
  conn: OdooConnection,
  expressionIds: number[],
  dateFrom: string,
  dateTo: string
): Promise<ExternalValuesScopeResult> {
  const warnings: string[] = [];
  try {
    const fieldsMeta = await getFieldsCached(cache, queue, conn, "account.report.external.value");
    const fkField = EXTERNAL_VALUE_FK_CANDIDATES.find((name) => name in fieldsMeta);
    if (!fkField) {
      warnings.push("account.report.external.value: no known report-expression FK field found; skipping.");
      return { output: { values: withModel("account.report.external.value", []) }, warnings };
    }
    const fields = pickExistingFields(["id", "date", "value", fkField, "company_id"], fieldsMeta);
    const rows = (await queue.enqueue(conn, "account.report.external.value", "search_read", {
      domain: [[fkField, "in", expressionIds]],
      fields,
      limit: 1000
    })) as Record<string, unknown>[];
    const values = normalizeRecords(rows, fieldsMeta).map((row) => ({
      ...row,
      in_period: isInPeriod(row.date, dateFrom, dateTo)
    }));
    return { output: { values: withModel("account.report.external.value", values) }, warnings };
  } catch (err) {
    warnings.push(warnOn("account.report.external.value", err));
    return { output: { values: withModel("account.report.external.value", []) }, warnings };
  }
}

interface SubScopeResult {
  container: RecordContainer;
  warning: string | null;
}

async function buildReturnTypesScope(cache: TtlCache, queue: OdooQueue, conn: OdooConnection): Promise<SubScopeResult> {
  try {
    const fieldsMeta = await getFieldsCached(cache, queue, conn, "account.return.type");
    const fields = pickExistingFields(ACCOUNT_RETURN_TYPE_FIELD_CANDIDATES, fieldsMeta);
    const rows = (await queue.enqueue(conn, "account.return.type", "search_read", {
      domain: [],
      fields,
      limit: 100
    })) as Record<string, unknown>[];
    return { container: withModel("account.return.type", normalizeRecords(rows, fieldsMeta)), warning: null };
  } catch (err) {
    return { container: withModel("account.return.type", []), warning: warnOn("account.return.type", err) };
  }
}

async function buildExistingReturnsScope(
  cache: TtlCache,
  queue: OdooQueue,
  conn: OdooConnection,
  companyId: number,
  dateFrom: string,
  dateTo: string
): Promise<SubScopeResult> {
  try {
    const fieldsMeta = await getFieldsCached(cache, queue, conn, "account.return");
    const fields = pickExistingFields(ACCOUNT_RETURN_FIELD_CANDIDATES, fieldsMeta);
    const rows = (await queue.enqueue(conn, "account.return", "search_read", {
      domain: [
        ["company_id", "=", companyId],
        ["date_from", "<=", dateTo],
        ["date_to", ">=", dateFrom]
      ],
      fields,
      limit: 100
    })) as Record<string, unknown>[];
    return { container: withModel("account.return", normalizeRecords(rows, fieldsMeta)), warning: null };
  } catch (err) {
    return { container: withModel("account.return", []), warning: warnOn("account.return", err) };
  }
}

interface KeyAccountsScopeResult {
  output: {
    balances: RecordContainer;
    top_open_lines: { model: string; by_account_id: Record<string, unknown[]> };
  };
  warnings: string[];
}

function emptyKeyAccountsOutput(): KeyAccountsScopeResult["output"] {
  return {
    balances: withModel("account.move.line", []),
    top_open_lines: { model: "account.move.line", by_account_id: {} }
  };
}

async function buildKeyAccountsScope(
  cache: TtlCache,
  queue: OdooQueue,
  conn: OdooConnection,
  companyId: number,
  keyAccountCodes: string[],
  dateTo: string
): Promise<KeyAccountsScopeResult> {
  const warnings: string[] = [];

  let accountIds: number[] = [];
  try {
    const fieldsMeta = await getFieldsCached(cache, queue, conn, "account.account");
    const companyField = ACCOUNT_ACCOUNT_COMPANY_FIELD_CANDIDATES.find((name) => name in fieldsMeta);
    const domain: unknown[] = [["code", "in", keyAccountCodes]];
    if (companyField === "company_id") domain.push([companyField, "=", companyId]);
    else if (companyField === "company_ids") domain.push([companyField, "in", [companyId]]);
    else warnings.push("account.account: no company_id/company_ids field found; results not filtered by company.");

    const fields = pickExistingFields([...ACCOUNT_ACCOUNT_FIELD_CANDIDATES, ...(companyField ? [companyField] : [])], fieldsMeta);
    const rows = (await queue.enqueue(conn, "account.account", "search_read", {
      domain,
      fields,
      limit: 100
    })) as Record<string, unknown>[];
    accountIds = rows.map((row) => row.id as number);
  } catch (err) {
    warnings.push(warnOn("account.account", err));
    return { output: emptyKeyAccountsOutput(), warnings };
  }

  if (accountIds.length === 0) {
    warnings.push(`No account.account records found for codes: ${keyAccountCodes.join(", ")}`);
    return { output: emptyKeyAccountsOutput(), warnings };
  }

  let moveLineFieldsMeta: FieldsMeta = {};
  try {
    moveLineFieldsMeta = await getFieldsCached(cache, queue, conn, "account.move.line");
  } catch (err) {
    warnings.push(warnOn("account.move.line", err));
  }

  let balances: unknown[] = [];
  try {
    const hasBalanceField = "balance" in moveLineFieldsMeta;
    const aggregates = hasBalanceField ? ["balance:sum"] : ["debit:sum", "credit:sum"];
    const rows = (await queue.enqueue(conn, "account.move.line", "read_group", {
      domain: [
        ["account_id", "in", accountIds],
        ["date", "<=", dateTo],
        ["parent_state", "=", "posted"],
        ["company_id", "=", companyId]
      ],
      fields: aggregates,
      groupby: ["account_id"],
      lazy: true
    })) as Record<string, unknown>[];
    const normalized = normalizeRecords(rows, moveLineFieldsMeta);
    balances = hasBalanceField
      ? normalized
      : normalized.map((row) => ({ ...row, balance: ((row.debit as number) ?? 0) - ((row.credit as number) ?? 0) }));
  } catch (err) {
    warnings.push(warnOn("account.move.line (balances)", err));
  }

  let topOpenLines: Record<string, unknown[]> = {};
  try {
    const fields = pickExistingFields(MOVE_LINE_OPEN_FIELD_CANDIDATES, moveLineFieldsMeta);
    const rows = (await queue.enqueue(conn, "account.move.line", "search_read", {
      domain: [
        ["account_id", "in", accountIds],
        ["amount_residual", "!=", 0],
        ["parent_state", "=", "posted"]
      ],
      fields,
      limit: 50
    })) as Record<string, unknown>[];
    topOpenLines = groupByAccountId(normalizeRecords(rows, moveLineFieldsMeta));
  } catch (err) {
    warnings.push(warnOn("account.move.line (open lines)", err));
  }

  return {
    output: {
      balances: withModel("account.move.line", balances),
      top_open_lines: { model: "account.move.line", by_account_id: topOpenLines }
    },
    warnings
  };
}

export function registerBookkeepingTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue, cache: TtlCache) {
  server.registerTool(
    "bookkeeping.get_snapshot",
    {
      title: "Get Bookkeeping Snapshot",
      description:
        "Read-only: assemble a bookkeeping/tax-close snapshot for a company over a period — company lock dates, tax " +
        "report structure, tax return types/instances, external (manually-entered) report values, and key account " +
        "balances. Select sections via `scopes`. Optional sub-models that may not exist on this Odoo version (e.g. " +
        "account.return) fail gracefully into `warnings` rather than aborting the whole request.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        company: z.string(),
        date_from: z.string(),
        date_to: z.string(),
        scopes: z.array(z.enum(["tax_report", "tax_returns", "return_types", "external_values", "key_accounts"])).min(1),
        key_account_codes: z.array(z.string()).optional()
      }
    },
    async ({ company, date_from, date_to, scopes, key_account_codes }) => {
      const callSnapshot = queue.snapshot();
      const startedAt = Date.now();
      const warnings: string[] = [];

      try {
        const conn = requireConnection(getProps());

        const companyFieldsMeta = await getFieldsCached(cache, queue, conn, "res.company");
        const existingLockFields = pickExistingFields(LOCK_FIELD_CANDIDATES, companyFieldsMeta);
        const companyRows = (await queue.enqueue(conn, "res.company", "search_read", {
          domain: [["name", "=", company]],
          fields: ["id", "name", "country_id", ...existingLockFields],
          limit: 1
        })) as Record<string, unknown>[];

        if (!companyRows || companyRows.length === 0) {
          return mcpError(`Company not found: ${company}`);
        }

        const companyRecord = companyRows[0];
        const normalizedCompany = normalizeRecord(companyRecord, companyFieldsMeta);
        const companyId = companyRecord.id as number;
        const countryTuple = companyRecord.country_id;
        const countryId = Array.isArray(countryTuple) && typeof countryTuple[0] === "number" ? (countryTuple[0] as number) : null;

        const lockDates: Record<string, unknown> = {};
        for (const field of existingLockFields) lockDates[field] = normalizedCompany[field];

        const result: Record<string, unknown> = {
          company: {
            id: companyId,
            name: normalizedCompany.name,
            country: normalizedCompany.country_id ?? null,
            lock_dates: lockDates
          },
          period: { date_from, date_to }
        };

        let expressionIds: number[] = [];

        if (scopes.includes("tax_report")) {
          const scopeResult = await buildTaxReportScope(cache, queue, conn, countryId);
          result.tax_report = scopeResult.output;
          expressionIds = scopeResult.expressionIds;
          warnings.push(...scopeResult.warnings);
        }

        if (scopes.includes("external_values")) {
          if (!scopes.includes("tax_report")) {
            warnings.push(
              "external_values scope requires tax_report to also be requested (to resolve report expression ids); skipping."
            );
          } else if (expressionIds.length === 0) {
            warnings.push("No tax report expressions available; skipping external_values.");
          } else {
            const scopeResult = await buildExternalValuesScope(cache, queue, conn, expressionIds, date_from, date_to);
            result.external_values = scopeResult.output;
            warnings.push(...scopeResult.warnings);
          }
        }

        if (scopes.includes("return_types") || scopes.includes("tax_returns")) {
          const taxReturns: Record<string, unknown> = {};
          if (scopes.includes("return_types")) {
            const { container, warning } = await buildReturnTypesScope(cache, queue, conn);
            taxReturns.return_types = container;
            if (warning) warnings.push(warning);
          }
          if (scopes.includes("tax_returns")) {
            const { container, warning } = await buildExistingReturnsScope(cache, queue, conn, companyId, date_from, date_to);
            taxReturns.existing_returns = container;
            if (warning) warnings.push(warning);
          }
          result.tax_returns = taxReturns;
        }

        if (scopes.includes("key_accounts")) {
          if (!key_account_codes || key_account_codes.length === 0) {
            warnings.push("key_accounts scope requested without key_account_codes; skipping.");
          } else {
            const scopeResult = await buildKeyAccountsScope(cache, queue, conn, companyId, key_account_codes, date_to);
            result.key_accounts = scopeResult.output;
            warnings.push(...scopeResult.warnings);
          }
        }

        const queueDelta = queue.delta(callSnapshot);
        const cacheMetrics = cache.getMetrics();
        result.warnings = warnings;
        result.metadata = {
          odoo_calls: queueDelta.odoo_calls,
          cache_hits: cacheMetrics.cache_hits,
          cache_misses: cacheMetrics.cache_misses,
          duration_seconds: (Date.now() - startedAt) / 1000
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return mcpErrorFromException(err, { model: "res.company", method: "search_read" });
      }
    }
  );
}

// ---- Source documents & attachments (card ODOO1086) ----

const ATTACHMENT_LIST_FIELDS = ["name", "mimetype", "file_size", "checksum", "type", "url", "res_field", "create_date"];

interface AttachmentRow {
  id: number;
  res_field: string | false;
  [key: string]: unknown;
}

/** Odoo may return a many2one as `[id, name]`, a bare id, or `false` depending on field shape. */
function extractRelationId(value: unknown): number | undefined {
  if (Array.isArray(value)) return value[0] as number;
  if (typeof value === "number") return value;
  return undefined;
}

function tagAttachment(
  attachment: AttachmentRow,
  mainAttachmentId: number | undefined,
  officialPdfId: number | undefined
): "original_source" | "official_pdf" | "other" {
  if (mainAttachmentId !== undefined && attachment.id === mainAttachmentId) return "original_source";
  if (attachment.res_field === "invoice_pdf_report_file" || attachment.id === officialPdfId) return "official_pdf";
  return "other";
}

export function registerSourceDocumentTools(server: McpServer, getProps: () => Props | undefined, queue: OdooQueue) {
  server.registerTool(
    "bookkeeping.list_source_documents",
    {
      title: "List Source Documents",
      description:
        "List the ir.attachment source documents on a record (e.g. account.move), tagging each as original_source, official_pdf, or other.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        model: z.string().default("account.move"),
        record_id: z.number().int().positive()
      }
    },
    async ({ model, record_id }) => {
      const before = queue.snapshot();
      try {
        const conn = requireConnection(getProps());
        const domain =
          model === "account.move"
            ? [
                "&",
                "&",
                ["res_model", "=", model],
                ["res_id", "=", record_id],
                "|",
                ["res_field", "=", false],
                ["res_field", "=", "invoice_pdf_report_file"]
              ]
            : ["&", "&", ["res_model", "=", model], ["res_id", "=", record_id], ["res_field", "=", false]];

        const attachments = (await queue.enqueue(conn, "ir.attachment", "search_read", {
          domain,
          fields: ATTACHMENT_LIST_FIELDS
        })) as AttachmentRow[];

        const warnings: string[] = [];
        let mainAttachmentId: number | undefined;
        let officialPdfId: number | undefined;

        if (model === "account.move") {
          try {
            const moves = (await queue.enqueue(conn, "account.move", "read", {
              ids: [record_id],
              fields: ["message_main_attachment_id", "invoice_pdf_report_id", "name", "state"]
            })) as Array<Record<string, unknown>>;
            const move = moves[0];
            mainAttachmentId = extractRelationId(move?.message_main_attachment_id);
            officialPdfId = extractRelationId(move?.invoice_pdf_report_id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`account.move read failed: ${message}`);
            warnings.push(`account.move read failed: ${message}`);
          }
        }

        const documents = attachments.map((attachment) => ({
          ...attachment,
          tag: tagAttachment(attachment, mainAttachmentId, officialPdfId)
        }));

        const { odoo_calls, total_duration_ms } = queue.delta(before);
        const metadata = { odoo_calls, cache_hits: 0, duration_seconds: total_duration_ms / 1000 };

        return { content: [{ type: "text" as const, text: JSON.stringify({ documents, warnings, metadata }, null, 2) }] };
      } catch (err) {
        return mcpErrorFromException(err, { model, method: "search_read" });
      }
    }
  );

  server.registerTool(
    "bookkeeping.fetch_attachment",
    {
      title: "Fetch Attachment",
      description:
        "Fetch an ir.attachment's metadata and, unless it's a URL-type attachment or exceeds max_bytes, its base64-encoded content.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        attachment_id: z.number().int().positive(),
        max_bytes: z.number().int().positive().default(10485760)
      }
    },
    async ({ attachment_id, max_bytes }) => {
      try {
        const conn = requireConnection(getProps());
        const metaRows = (await queue.enqueue(conn, "ir.attachment", "read", {
          ids: [attachment_id],
          fields: ["name", "mimetype", "file_size", "type", "url"]
        })) as Array<Record<string, unknown>>;

        const meta = metaRows[0];
        if (!meta) return mcpError(`No ir.attachment record found for id ${attachment_id}`);

        if (meta.type === "url") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ name: meta.name, mimetype: meta.mimetype, file_size: meta.file_size, url: meta.url }, null, 2)
              }
            ]
          };
        }

        const fileSize = meta.file_size as number;
        if (fileSize > max_bytes) {
          return mcpError(
            `Attachment ${attachment_id} is ${fileSize} bytes, exceeding max_bytes (${max_bytes}). Base64 encoding inflates the payload ~1.37x against Worker memory limits, so it was not fetched. Raise max_bytes if you really need this file.`
          );
        }

        const dataRows = (await queue.enqueue(conn, "ir.attachment", "read", {
          ids: [attachment_id],
          fields: ["name", "mimetype", "file_size", "type", "url", "datas"]
        })) as Array<Record<string, unknown>>;
        const data = dataRows[0];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ name: data.name, mimetype: data.mimetype, file_size: data.file_size, base64: data.datas }, null, 2)
            }
          ]
        };
      } catch (err) {
        return mcpErrorFromException(err, { model: "ir.attachment", method: "read" });
      }
    }
  );
}
