export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Semaphore capacity must be a positive integer");
  }

  get pending(): number {
    return this.waiters.length;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (this.active < this.capacity) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => {
        signal?.removeEventListener("abort", abort);
        this.active++;
        resolve();
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      this.waiters.push(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    next?.();
  }
}
