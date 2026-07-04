import type { OdooConnection } from "./odoo";
import type { OdooQueue } from "./odoo-queue";

export interface TtlCacheOptions {
  clock?: () => number;
  maxEntries?: number;
}

export interface CacheMetrics {
  cache_hits: number;
  cache_misses: number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 500;

export const TTL_METADATA_MS = 6 * 60 * 60 * 1000; // fields_get / XML ID resolution
export const TTL_STRUCTURE_MS = 60 * 60 * 1000; // chart of accounts, taxes, report structure
export const TTL_BALANCE_MS = 60 * 1000; // account balances

/**
 * In-memory TTL cache for stable Odoo metadata, so repeated lookups within a
 * TTL window skip OdooQueue's 1 req/sec serialized queue entirely. One
 * instance per McpAgent/Durable Object; resets on DO eviction.
 */
export class TtlCache {
  private readonly clock: () => number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(options: TtlCacheOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (this.clock() >= entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: this.clock() + ttlMs });
  }

  async getOrCompute<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }

  getMetrics(): CacheMetrics {
    return { cache_hits: this.hits, cache_misses: this.misses };
  }
}

export interface CachedFieldMeta {
  type: string;
  string: string;
  selection?: [string, string][];
  relation?: string;
  store?: boolean;
}

export interface XmlIdResolution {
  model: string;
  res_id: number;
}

export async function getFieldsCached(
  cache: TtlCache,
  queue: OdooQueue,
  conn: OdooConnection,
  model: string
): Promise<Record<string, CachedFieldMeta>> {
  const key = `fields:${conn.db}:${model}`;
  return cache.getOrCompute(key, TTL_METADATA_MS, async () => {
    return (await queue.enqueue(conn, model, "fields_get", {
      attributes: ["type", "string", "selection", "relation", "store"]
    })) as Record<string, CachedFieldMeta>;
  });
}

export async function resolveXmlIdCached(
  cache: TtlCache,
  queue: OdooQueue,
  conn: OdooConnection,
  xmlId: string
): Promise<XmlIdResolution> {
  const key = `xmlid:${conn.db}:${xmlId}`;
  return cache.getOrCompute(key, TTL_METADATA_MS, async () => {
    const dotIndex = xmlId.indexOf(".");
    if (dotIndex === -1) throw new Error(`Invalid XML ID "${xmlId}": expected "module.name" format`);
    const module = xmlId.slice(0, dotIndex);
    const name = xmlId.slice(dotIndex + 1);

    const records = (await queue.enqueue(conn, "ir.model.data", "search_read", {
      domain: [
        ["module", "=", module],
        ["name", "=", name]
      ],
      fields: ["model", "res_id"],
      limit: 1
    })) as Array<{ model: string; res_id: number }>;

    const record = records[0];
    if (!record) throw new Error(`XML ID "${xmlId}" not found`);
    return { model: record.model, res_id: record.res_id };
  });
}

export async function cachedSearchRead(
  cache: TtlCache,
  queue: OdooQueue,
  conn: OdooConnection,
  cacheKey: string,
  ttlMs: number,
  model: string,
  domain: unknown[],
  fields: string[],
  limit?: number
): Promise<unknown[]> {
  return cache.getOrCompute(cacheKey, ttlMs, async () => {
    return (await queue.enqueue(conn, model, "search_read", {
      domain,
      fields,
      ...(limit !== undefined ? { limit } : {})
    })) as unknown[];
  });
}
