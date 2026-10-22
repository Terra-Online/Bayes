// Runtime adapter only. Production DO classes execute against these isolated
// stores; native Workers scheduling, persistence and alarms need runtime tests.
export class ProgressTestStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  failNextTransaction = false;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let deleted = 0;
      keyOrKeys.forEach((key) => {
        if (this.values.delete(key)) {
          deleted += 1;
        }
      });
      return deleted;
    }
    return this.values.delete(keyOrKeys);
  }

  async list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options?.limit);
    return new Map(entries) as Map<string, T>;
  }

  async transaction<T>(closure: (transaction: ProgressTestStorage) => Promise<T>): Promise<T> {
    // Failure injection happens before any writes, so it cannot prove rollback
    // after a partial write in native Durable Object storage.
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      throw new Error("injected storage transaction failure");
    }
    const transaction = new ProgressTestStorage();
    transaction.values = structuredClone(this.values);
    transaction.alarm = this.alarm;
    const result = await closure(transaction);
    this.values = transaction.values;
    this.alarm = transaction.alarm;
    return result;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(value: number | Date): Promise<void> {
    this.alarm = Number(value);
  }
}

export interface ProgressTestState {
  state: DurableObjectState;
  waits: Promise<unknown>[];
  storage: ProgressTestStorage;
}

export function createProgressTestState(
  name?: string,
  storage = new ProgressTestStorage(),
): ProgressTestState {
  const waits: Promise<unknown>[] = [];
  return {
    state: {
      id: { name },
      storage,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    } as unknown as DurableObjectState,
    waits,
    storage,
  };
}
