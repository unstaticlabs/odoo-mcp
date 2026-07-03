import { type OdooConnection, callOdoo } from "./odoo";

export interface OdooQueueOptions {
  minDelayMs?: number;
}

export interface CallMetric {
  model: string;
  method: string;
  ms: number;
  ok: boolean;
}

export interface Metrics {
  odoo_calls: number;
  total_duration_ms: number;
  calls: CallMetric[];
}

interface QueueItem {
  run: () => Promise<void>;
}

const DEFAULT_MIN_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes every Odoo call through a single FIFO queue with a minimum delay
 * enforced between call starts, so Odoo Online (~1 req/sec, no parallelism)
 * never sees overlapping requests. One instance per McpAgent/Durable Object.
 */
export class OdooQueue {
  private readonly callOdooFn: typeof callOdoo;
  private readonly minDelayMs: number;
  private readonly queue: QueueItem[] = [];
  private readonly calls: CallMetric[] = [];
  private draining = false;
  private lastStartTime = 0;

  constructor(callOdooFn: typeof callOdoo, options: OdooQueueOptions = {}) {
    this.callOdooFn = callOdooFn;
    this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  }

  enqueue<T>(
    conn: OdooConnection,
    model: string,
    method: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: async () => {
          const start = Date.now();
          try {
            const result = await this.callOdooFn(conn, model, method, args, timeoutMs);
            this.calls.push({ model, method, ms: Date.now() - start, ok: true });
            resolve(result as T);
          } catch (err) {
            this.calls.push({ model, method, ms: Date.now() - start, ok: false });
            reject(err);
          }
        }
      });
      if (!this.draining) {
        this.draining = true;
        void this.drain();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const wait = Math.max(0, this.minDelayMs - (Date.now() - this.lastStartTime));
      if (wait > 0) await sleep(wait);

      const item = this.queue.shift();
      if (!item) continue;
      this.lastStartTime = Date.now();
      await item.run();
    }
    this.draining = false;
  }

  getMetrics(): Metrics {
    return {
      odoo_calls: this.calls.length,
      total_duration_ms: this.calls.reduce((sum, call) => sum + call.ms, 0),
      calls: [...this.calls]
    };
  }

  snapshot(): number {
    return this.calls.length;
  }

  delta(snapshot: number): Metrics {
    const slice = this.calls.slice(snapshot);
    return {
      odoo_calls: slice.length,
      total_duration_ms: slice.reduce((sum, call) => sum + call.ms, 0),
      calls: [...slice]
    };
  }
}
