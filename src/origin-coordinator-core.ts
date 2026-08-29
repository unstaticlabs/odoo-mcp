export const ORIGIN_QUEUE_MAX_WAITING = 50;
export const ORIGIN_QUEUE_MAX_WAIT_MS = 60_000;
export const ORIGIN_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface OriginCoordinatorOptions {
  maxWaiting?: number;
  maxWaitMs?: number;
  fetchFn?: typeof fetch;
  expectedOrigin?: string;
  maxResponseBytes?: number;
}

interface PendingRequest {
  request: Request;
  enqueuedAt: number;
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

function originBusy(reason: "queue_full" | "wait_timeout", retryAfterSeconds = 1): Response {
  return Response.json(
    {
      error: {
        code: "origin_busy",
        reason,
        recoverable: true,
        retry_after_seconds: retryAfterSeconds,
        guidance: "Retry the same logical operation later. For a mutation, reuse the same idempotency key."
      }
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds)
      }
    }
  );
}

/**
 * In-memory FIFO used by one origin-keyed Durable Object instance. It retains
 * credentials and bodies only while the corresponding request is waiting or
 * in flight; nothing is written to Durable Object storage or logs.
 */
export class OriginCoordinatorCore {
  private readonly maxWaiting: number;
  private readonly maxWaitMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly expectedOrigin?: string;
  private readonly maxResponseBytes: number;
  private readonly waiting: PendingRequest[] = [];
  private active = false;
  private drainPromise: Promise<void> | undefined;

  constructor(options: OriginCoordinatorOptions = {}) {
    this.maxWaiting = Math.max(1, options.maxWaiting ?? ORIGIN_QUEUE_MAX_WAITING);
    this.maxWaitMs = Math.max(1, options.maxWaitMs ?? ORIGIN_QUEUE_MAX_WAIT_MS);
    this.fetchFn = options.fetchFn ?? fetch;
    this.expectedOrigin = options.expectedOrigin;
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes ?? ORIGIN_MAX_RESPONSE_BYTES);
  }

  handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isJson2 =
      request.method === "POST" &&
      /^\/json\/2\/[A-Za-z_][A-Za-z0-9_.]{0,254}\/[A-Za-z][A-Za-z0-9_]{0,254}$/.test(url.pathname);
    const isApiDoc =
      request.method === "GET" &&
      /^\/doc-bearer\/(?:index|[A-Za-z_][A-Za-z0-9_.]{0,254})\.json$/.test(url.pathname);
    if (!isJson2 && !isApiDoc) {
      return Promise.resolve(Response.json({ error: { code: "method_not_allowed" } }, { status: 405 }));
    }

    if (this.expectedOrigin && url.origin !== this.expectedOrigin) {
      return Promise.resolve(Response.json({ error: { code: "invalid_coordinator_target" } }, { status: 400 }));
    }

    if ((this.active || this.waiting.length > 0) && this.waiting.length >= this.maxWaiting) {
      return Promise.resolve(originBusy("queue_full"));
    }

    const result = new Promise<Response>((resolve) => {
      const item: PendingRequest = {
        request,
        enqueuedAt: Date.now(),
        resolve,
        settled: false,
        timer: setTimeout(() => {
          if (item.settled) return;
          item.settled = true;
          resolve(originBusy("wait_timeout"));
        }, this.maxWaitMs)
      };
      this.waiting.push(item);
    });

    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = undefined;
      });
    }
    return result;
  }

  private async drain(): Promise<void> {
    while (this.waiting.length > 0) {
      const item = this.waiting.shift();
      if (!item || item.settled) continue;
      if (Date.now() - item.enqueuedAt >= this.maxWaitMs) {
        clearTimeout(item.timer);
        item.settled = true;
        item.resolve(originBusy("wait_timeout"));
        continue;
      }

      this.active = true;
      clearTimeout(item.timer);
      try {
        const response = await this.fetchFn(item.request, { redirect: "manual" });
        const declared = Number(response.headers.get("Content-Length"));
        if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
          await response.body?.cancel();
          item.settled = true;
          item.resolve(
            Response.json(
              { error: { code: "coordinator_response_too_large", recoverable: false } },
              { status: 502, headers: { "Cache-Control": "no-store" } }
            )
          );
          continue;
        }

        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > this.maxResponseBytes) {
                await reader.cancel("coordinator response size limit exceeded");
                item.settled = true;
                item.resolve(
                  Response.json(
                    { error: { code: "coordinator_response_too_large", recoverable: false } },
                    { status: 502, headers: { "Cache-Control": "no-store" } }
                  )
                );
                break;
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        if (item.settled) continue;

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        item.settled = true;
        item.resolve(
          new Response(total > 0 ? bytes : null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          })
        );
      } catch {
        item.settled = true;
        item.resolve(
          Response.json(
            { error: { code: "coordinator_fetch_failed", recoverable: true } },
            { status: 502, headers: { "Cache-Control": "no-store" } }
          )
        );
      } finally {
        this.active = false;
      }
    }
  }
}
