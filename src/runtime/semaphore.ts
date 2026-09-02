export class Semaphore {
  private active = 0;
  private readonly foregroundWaiters: Array<() => void> = [];
  private readonly backgroundWaiters: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Semaphore capacity must be a positive integer");
  }

  get pending(): number {
    return this.foregroundWaiters.length + this.backgroundWaiters.length;
  }

  async run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
    priority: "foreground" | "background" = "foreground"
  ): Promise<T> {
    await this.acquire(signal, priority);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal, priority: "foreground" | "background" = "foreground"): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (this.active < this.capacity) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiters = priority === "foreground" ? this.foregroundWaiters : this.backgroundWaiters;
      const ready = (): void => {
        signal?.removeEventListener("abort", abort);
        this.active++;
        resolve();
      };
      const abort = (): void => {
        const index = waiters.indexOf(ready);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      waiters.push(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private release(): void {
    this.active--;
    const next = this.foregroundWaiters.shift() ?? this.backgroundWaiters.shift();
    next?.();
  }
}
