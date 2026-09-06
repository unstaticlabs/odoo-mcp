import { createHash } from "node:crypto";
import { z } from "zod";

const MODEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

export const ModelNameSchema = z.string().regex(MODEL_PATTERN, "Invalid Odoo model name");
export const FieldNameSchema = z.string().regex(FIELD_PATTERN, "Invalid Odoo field name");
export const MethodNameSchema = z.string().regex(METHOD_PATTERN, "Invalid public Odoo method name");
export const PositiveIdSchema = z.number().int().positive();
export const FieldsSchema = z.array(FieldNameSchema).max(100);
export const OdooContextSchema = z.record(z.string().min(1).max(128), z.unknown()).default({});

const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

// Odoo evaluates a domain in prefix (Polish) notation. Typing the leaf and the
// connective separately lets a malformed filter fail here, with a message the
// caller can act on, instead of surfacing as an opaque Odoo error.
export const DomainOperatorSchema = z.enum([
  "=", "!=", ">", ">=", "<", "<=", "=?",
  "like", "not like", "=like", "ilike", "not ilike", "=ilike",
  "in", "not in", "child_of", "parent_of", "any", "not any"
]);
export const DomainConnectiveSchema = z.enum(["&", "|", "!"]);
const DomainFieldPathSchema = z.string().max(255).regex(FIELD_PATH_PATTERN, "Invalid Odoo field path");
const DomainLeafSchema = z.tuple([DomainFieldPathSchema, DomainOperatorSchema, z.unknown()]);
// Odoo's own TRUE_LEAF/FALSE_LEAF constants, which carry an integer where a
// field path would otherwise sit.
const DomainConstantSchema = z.tuple([z.union([z.literal(0), z.literal(1)]), z.literal("="), z.literal(1)]);
const DomainTermSchema = z.union([DomainConnectiveSchema, DomainConstantSchema, DomainLeafSchema]);

function inspectJson(value: unknown, depth: number, state: { keys: number }): void {
  if (depth > 8) throw new Error("JSON may not exceed 8 levels of nesting");
  if (Array.isArray(value)) {
    for (const item of value) inspectJson(item, depth + 1, state);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    state.keys++;
    if (state.keys > 200) throw new Error("JSON may not contain more than 200 object keys");
    if (key.length > 128) throw new Error("JSON keys may not exceed 128 characters");
    inspectJson(item, depth + 1, state);
  }
}

export function assertBoundedJson(value: unknown, bytes = 256 * 1024): void {
  inspectJson(value, 0, { keys: 0 });
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) throw new Error(`JSON exceeds the ${bytes}-byte limit`);
}

export function assertBoundedDomain(domain: unknown): asserts domain is unknown[] {
  if (!Array.isArray(domain)) throw new Error("domain must be an Odoo domain array");
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) throw new Error("domain may not exceed 8 levels of nesting");
    nodes++;
    if (nodes > 200) throw new Error("domain may not exceed 200 nodes");
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
  };
  visit(domain, 0);
  assertBoundedJson(domain);
}

// Mirrors Odoo's `expression.normalize_domain` arity walk: `&` and `|` each
// consume two following expressions, `!` consumes one, and leftover top-level
// expressions are implicitly AND-ed. A connective left without enough operands
// is the most common malformed-domain error and is silent until Odoo rejects it.
export function assertDomainStructure(domain: readonly unknown[]): void {
  if (domain.length === 0) return;
  let expected = 1;
  for (const term of domain) {
    if (expected === 0) expected = 1;
    if (term === "&" || term === "|") expected += 1;
    else if (term !== "!") expected -= 1;
  }
  if (expected !== 0) {
    throw new Error(
      "domain is malformed: every \"&\" and \"|\" needs two following conditions and \"!\" needs one. "
      + "Odoo reads domains in prefix notation, so [\"|\", [\"a\", \"=\", 1], [\"b\", \"=\", 2]] means a OR b."
    );
  }
}

export const DomainSchema = z.array(DomainTermSchema)
  .max(200)
  .superRefine((domain, ctx) => {
    for (const assertion of [() => assertBoundedDomain(domain), () => assertDomainStructure(domain)]) {
      try {
        assertion();
      } catch (error) {
        ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
  })
  .default([]);

// Odoo's read specification, as consumed by web_search_read, web_read and
// web_save: a map of field name to an options node. A bare `{}` returns the
// field's raw value (a many2one comes back as its id); `fields` requests a
// nested read of a relational field, and `limit`/`order` bound an x2many.
const SPECIFICATION_MAX_DEPTH = 4;
type SpecificationNode = {
  fields?: Record<string, SpecificationNode>;
  limit?: number;
  order?: string;
};
const SpecificationNodeSchema: z.ZodType<SpecificationNode> = z.lazy(() => z.object({
  fields: z.record(FieldNameSchema, SpecificationNodeSchema).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  order: z.string().min(1).max(300).optional()
}).strict());

function specificationDepth(node: SpecificationNode): number {
  const children = Object.values(node.fields ?? {});
  return children.length === 0 ? 1 : 1 + Math.max(...children.map(specificationDepth));
}

export const SpecificationSchema = z.record(FieldNameSchema, SpecificationNodeSchema)
  .superRefine((specification, ctx) => {
    if (Object.keys(specification).length === 0) {
      ctx.addIssue({ code: "custom", message: "specification must name at least one field" });
      return;
    }
    const depth = Math.max(...Object.values(specification).map(specificationDepth));
    if (depth > SPECIFICATION_MAX_DEPTH) {
      ctx.addIssue({ code: "custom", message: `specification may not nest deeper than ${SPECIFICATION_MAX_DEPTH} relations` });
      return;
    }
    try {
      assertBoundedJson(specification);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    }
  });

export type Specification = z.infer<typeof SpecificationSchema>;

// A page cursor is either an offset or, when the query is ordered by id alone,
// the last id seen. Keyset paging cannot skip or repeat rows when records are
// inserted or deleted between pages; offset paging can. Both are bound to the
// query fingerprint so a cursor is never replayed against a different query.
export type PageCursor = { kind: "offset"; offset: number } | { kind: "keyset"; after: number };

interface CursorPayload {
  offset?: number;
  after?: number;
  fingerprint: string;
}

const KEYSET_ORDER = /^\s*id\s+(asc|desc)\s*$/i;

/** The keyset direction for an order clause, or undefined when it must page by offset. */
export function keysetDirection(order: string): "asc" | "desc" | undefined {
  const match = KEYSET_ORDER.exec(order);
  return match ? (match[1]!.toLowerCase() as "asc" | "desc") : undefined;
}

export function encodePageCursor(cursor: PageCursor, fingerprint: string): string {
  const payload: CursorPayload = cursor.kind === "offset"
    ? { offset: cursor.offset, fingerprint }
    : { after: cursor.after, fingerprint };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePageCursor(value: string | undefined, fingerprint: string): PageCursor {
  if (!value) return { kind: "offset", offset: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is malformed");
  }
  const cursor = z.object({
    offset: z.number().int().nonnegative().max(10_000_000).optional(),
    after: z.number().int().positive().optional(),
    fingerprint: z.string()
  }).strict().parse(parsed);
  if (cursor.fingerprint !== fingerprint) throw new Error("cursor does not match this query");
  if (cursor.after !== undefined) return { kind: "keyset", after: cursor.after };
  return { kind: "offset", offset: cursor.offset ?? 0 };
}

export function queryFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 24);
}

export function encodeCursor(offset: number, fingerprint: string): string {
  return encodePageCursor({ kind: "offset", offset }, fingerprint);
}

export function decodeCursor(value: string | undefined, fingerprint: string): number {
  const cursor = decodePageCursor(value, fingerprint);
  if (cursor.kind !== "offset") throw new Error("cursor does not match this query");
  return cursor.offset;
}

export function attributedContext(
  requested: Record<string, unknown> | undefined,
  correlationId: string
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requested ?? {})) {
    if (!key.startsWith("usl_")) context[key] = value;
  }
  context.usl_agent_origin = "odoo-mcp";
  context.usl_correlation_id = correlationId;
  assertBoundedJson(context);
  return context;
}

// The Odoo context keys that decide which records a call can even see. They are
// still accepted inside `context`, but naming them makes company scope, language
// and archived-record visibility part of the contract instead of folklore.
export const CallScopeShape = {
  company_ids: z.array(PositiveIdSchema).min(1).max(50).optional(),
  lang: z.string().max(35).regex(/^[a-z]{2,3}(?:_[A-Z]{2})?(?:@[A-Za-z]+)?$/, "Invalid Odoo language code").optional(),
  active_test: z.boolean().optional()
} as const;

export interface CallScopeInput {
  company_ids?: readonly number[];
  lang?: string;
  active_test?: boolean;
  context?: Record<string, unknown>;
}

const SCOPE_CONTEXT_KEYS = {
  company_ids: "allowed_company_ids",
  lang: "lang",
  active_test: "active_test"
} as const;

export interface ResolvedCallScope {
  context: Record<string, unknown>;
  warnings: string[];
}

/**
 * Merge the named scope parameters over the free-form context, then apply
 * connector attribution. A named parameter wins over the same key supplied
 * inside `context`, and the override is reported rather than applied silently.
 */
export function resolveCallScope(input: CallScopeInput, correlationId: string): ResolvedCallScope {
  const context = attributedContext(input.context, correlationId);
  const warnings: string[] = [];
  for (const [parameter, key] of Object.entries(SCOPE_CONTEXT_KEYS) as [keyof typeof SCOPE_CONTEXT_KEYS, string][]) {
    const value = input[parameter];
    if (value === undefined) continue;
    if (key in context) {
      warnings.push(`The ${parameter} parameter overrode context.${key}; the named parameter is authoritative.`);
    }
    context[key] = parameter === "company_ids" ? [...(value as readonly number[])] : value;
  }
  assertBoundedJson(context);
  return { context, warnings };
}

const RELATIONAL_COMMAND_KEYS = ["clear", "set", "delete", "unlink", "update", "create", "link"] as const;
type RelationalCommandKey = (typeof RELATIONAL_COMMAND_KEYS)[number];

const RelationalCommandsSchema = z.object({
  clear: z.literal(true).optional(),
  set: z.array(PositiveIdSchema).max(1000).optional(),
  delete: z.array(PositiveIdSchema).max(1000).optional(),
  unlink: z.array(PositiveIdSchema).max(1000).optional(),
  update: z.array(z.object({
    id: PositiveIdSchema,
    values: z.record(z.string(), z.unknown())
  }).strict()).max(100).optional(),
  create: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  link: z.array(PositiveIdSchema).max(1000).optional()
}).strict();

// Odoo command codes, in the order the lowered list applies them.
const RELATIONAL_COMMAND_CODES: Record<RelationalCommandKey, number> = {
  clear: 5, set: 6, delete: 2, unlink: 3, update: 1, create: 0, link: 4
};

function isRelationalCommandObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => (RELATIONAL_COMMAND_KEYS as readonly string[]).includes(key));
}

function lowerRelationalCommands(field: string, value: unknown): unknown[] {
  const parsed = RelationalCommandsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${field} looks like a relational command object but is malformed: ${parsed.error.issues[0]?.message ?? "invalid"}. `
      + "Use {link|unlink|delete|set: [ids]}, {create: [values]}, {update: [{id, values}]} or {clear: true}."
    );
  }
  const commands = parsed.data;
  if (commands.clear && commands.set) {
    throw new Error(`${field} may not combine "clear" with "set"; "set" already replaces the whole relation.`);
  }
  const lowered: unknown[] = [];
  for (const key of RELATIONAL_COMMAND_KEYS) {
    const code = RELATIONAL_COMMAND_CODES[key];
    if (key === "clear") {
      if (commands.clear) lowered.push([code, 0, 0]);
    } else if (key === "set") {
      if (commands.set) lowered.push([code, 0, [...commands.set]]);
    } else if (key === "update") {
      for (const entry of commands.update ?? []) lowered.push([code, entry.id, entry.values]);
    } else if (key === "create") {
      for (const entry of commands.create ?? []) lowered.push([code, 0, entry]);
    } else {
      for (const id of commands[key] ?? []) lowered.push([code, id, 0]);
    }
  }
  if (lowered.length === 0) throw new Error(`${field} specified no relational command`);
  return lowered;
}

function isExplicitCommandList(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) =>
    Array.isArray(item) && Number.isInteger(item[0]) && (item[0] as number) >= 0 && (item[0] as number) <= 6
  );
}

function normalizeExplicitCommands(field: string, value: readonly unknown[]): unknown[] {
  return value.map((item) => {
    const tuple = item as unknown[];
    if (tuple.length < 2 || tuple.length > 3) {
      throw new Error(`${field} contains an Odoo command tuple of length ${tuple.length}; expected (code, id) or (code, id, values).`);
    }
    const [code, id, payload] = tuple;
    if (!Number.isInteger(id) || (id as number) < 0) {
      throw new Error(`${field} contains an Odoo command with a non-identifier second element.`);
    }
    return [code, id, tuple.length === 3 ? payload : 0];
  });
}

/**
 * Accept relational values either as raw Odoo command tuples or as a named form,
 * and lower the named form to the tuples Odoo expects. x2many commands are the
 * most error-prone part of writing through the ORM; naming them lets a mistake
 * fail here with a specific message instead of writing the wrong relation.
 */
export function normalizeWriteValues(values: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    normalized[field] = isRelationalCommandObject(value)
      ? lowerRelationalCommands(field, value)
      : isExplicitCommandList(value)
        ? normalizeExplicitCommands(field, value)
        : value;
  }
  return normalized;
}
