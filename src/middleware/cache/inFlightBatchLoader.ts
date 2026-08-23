type PendingLoad<Value> = {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
  batchLoad: (keys: string[]) => Promise<Map<string, Value>>;
};

export class InFlightBatchLoader<Value> {
  private readonly inFlight = new Map<string, PendingLoad<Value>>();
  private readonly pending = new Map<string, PendingLoad<Value>>();
  private flushScheduled = false;

  constructor(private readonly maxBatchSize = 100) {}

  load(
    key: string,
    batchLoad: (keys: string[]) => Promise<Map<string, Value>>
  ): Promise<Value> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing.promise;
    }

    let resolve!: (value: Value) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const load = { promise, resolve, reject, batchLoad };
    this.inFlight.set(key, load);
    this.pending.set(key, load);
    this.scheduleFlush();
    return promise;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    if (entries.length === 0) return;

    try {
      const batches: Array<typeof entries> = [];
      for (let index = 0; index < entries.length; index += this.maxBatchSize) {
        batches.push(entries.slice(index, index + this.maxBatchSize));
      }
      await Promise.all(batches.map((batch) => this.resolveBatch(batch)));
    } finally {
      entries.forEach(([key, load]) => {
        if (this.inFlight.get(key) === load) {
          this.inFlight.delete(key);
        }
      });
    }
  }

  private async resolveBatch(entries: Array<[string, PendingLoad<Value>]>): Promise<void> {
    const keys = entries.map(([key]) => key);
    try {
      const values = await entries[0]![1].batchLoad(keys);
      entries.forEach(([key, load]) => {
        if (!values.has(key)) {
          load.reject(new Error(`Batch loader did not return a value for key: ${key}`));
          return;
        }
        load.resolve(values.get(key)!);
      });
    } catch (error) {
      entries.forEach(([, load]) => load.reject(error));
    }
  }
}
