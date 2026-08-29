import { type OdooCallOptions, type OdooConnection, callOdoo } from "./odoo";

export interface OdooQueueOptions {
  minDelayMs?: number;
  maxMetricsEntries?: number;
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
  dropped_calls?: number;
}

interface QueueItem {
  run: () => Promise<void>;
}

const DEFAULT_MIN_DELAY_MS = 1000;
const DEFAULT_MAX_METRICS = 1000;

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
  private readonly maxMetricsEntries: number;
  private readonly queue: QueueItem[] = [];
  private readonly calls: CallMetric[] = [];
  private completedCalls = 0;
  private totalDurationMs = 0;
  private draining = false;
  private lastStartTime = 0;

  constructor(callOdooFn: typeof callOdoo, options: OdooQueueOptions = {}) {
    this.callOdooFn = callOdooFn;
    this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.maxMetricsEntries = Math.max(1, options.maxMetricsEntries ?? DEFAULT_MAX_METRICS);
  }

  enqueue<T>(
    conn: OdooConnection,
    model: string,
    method: string,
    args: Record<string, unknown>,
    options?: number | OdooCallOptions
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: async () => {
          const start = Date.now();
          try {
            const result = await this.callOdooFn(conn, model, method, args, options);
            this.recordMetric({ model, method, ms: Date.now() - start, ok: true });
            resolve(result as T);
          } catch (err) {
            this.recordMetric({ model, method, ms: Date.now() - start, ok: false });
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

  private recordMetric(metric: CallMetric): void {
    this.completedCalls++;
    this.totalDurationMs += metric.ms;
    this.calls.push(metric);
    if (this.calls.length > this.maxMetricsEntries) this.calls.shift();
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
      odoo_calls: this.completedCalls,
      total_duration_ms: this.totalDurationMs,
      calls: [...this.calls],
      dropped_calls: this.completedCalls - this.calls.length
    };
  }

  snapshot(): number {
    return this.completedCalls;
  }

  delta(snapshot: number): Metrics {
    const retainedStart = this.completedCalls - this.calls.length;
    const startIndex = Math.max(0, snapshot - retainedStart);
    const slice = this.calls.slice(startIndex);
    return {
      odoo_calls: Math.max(0, this.completedCalls - snapshot),
      total_duration_ms: slice.reduce((sum, call) => sum + call.ms, 0),
      calls: [...slice],
      dropped_calls: Math.max(0, retainedStart - snapshot)
    };
  }
}
