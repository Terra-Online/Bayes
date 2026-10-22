import { Hono } from "hono";
import { vi, type Mocked } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { requestIdMiddleware } from "@/middleware/request-id";
import { createRoutes } from "@/routes/progress/createRoutes";
import { OEMUserDO } from "@/services/progress/userDo";
import { createMockBindings } from "@/test/bindings";
import type { TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession } from "@/test/fixtures/auth";
import type { AppEnv } from "@/types/app";

/** DO storage protocol stand-in. Failure injection rejects before the closure,
 * so this does not claim native partial-write transaction rollback coverage. */
export class FakeStorage {
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

  async transaction<T>(closure: (transaction: FakeStorage) => Promise<T>): Promise<T> {
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      throw new Error("injected storage transaction failure");
    }
    const transaction = new FakeStorage();
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

export interface ProgressState {
  state: DurableObjectState;
  waits: Promise<unknown>[];
  storage: FakeStorage;
}
export function createProgressState(name?: string, storage = new FakeStorage()): ProgressState {
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

interface ProgressObject {
  object: OEMUserDO;
  state: ProgressState;
}

export interface ProgressFixture {
  request: (request: Request) => Promise<Response>;
  object: OEMUserDO;
  markerIndexHash: string;
  archiveIndexHash: string;
  state: ProgressState;
}

export function insertProgressManifest(
  database: TestDatabase,
  hash: string,
  pointIds: string[],
): void {
  database.sqlite
    .prepare(`INSERT INTO progress_marker_manifests
    (marker_index_hash, format_version, bits_per_point, point_count, point_ids, created_at)
    VALUES (?, 1, 1, ?, ?, 0)`)
    .run(hash, pointIds.length, JSON.stringify(pointIds));
}

// Only the used fetch surface is configured; unexpected external operations fail.
function progressStub(name: string, fetch: Fetcher["fetch"]): DurableObjectStub {
  const id: DurableObjectId = {
    name,
    toString: () => name,
    equals: (other) => other.name === name,
  };
  return {
    id,
    name,
    fetch,
    connect: () => {
      throw new Error("Unexpected progress stub connect");
    },
  };
}

export function createProgressFixture(
  database: TestDatabase,
  uid = "A",
  statsFetch: Fetcher["fetch"] = async () => new Response("{}"),
): ProgressFixture {
  const markerIndexHash = "a".repeat(64);
  const archiveIndexHash = "c".repeat(64);
  insertProgressManifest(database, markerIndexHash, ["p1", "p2"]);
  database.sqlite
    .prepare(`INSERT INTO archive_progress_manifests
    (archive_index_hash, format_version, bits_per_archive, archive_count, archive_ids, created_at)
    VALUES (?, 1, 1, 2, ?, 0)`)
    .run(archiveIndexHash, JSON.stringify(["archive-a", "archive-b"]));
  insertAuthUser(database.sqlite, { id: uid });
  const { headers } = insertSession(database.sqlite, { userId: uid });
  const mocks = createMockBindings({ DB: database.db });
  mocks.bindings.LOCK_PROGRESS_ENDPOINTS = "false";
  const statsStub: Mocked<DurableObjectStub> = {
    ...progressStub(markerIndexHash, statsFetch),
    fetch: vi.fn<Fetcher["fetch"]>().mockImplementation(statsFetch),
    connect: vi.fn<Fetcher["connect"]>().mockImplementation(() => {
      throw new Error("Unexpected Stats connect");
    }),
  };
  mocks.statsObjects.getByName.mockImplementation((name) => {
    if (name !== markerIndexHash) {
      throw new Error(`Unexpected Stats name: ${name}`);
    }
    return statsStub;
  });
  // Reuse the real instance by identity, including its in-memory request queue.
  const objects = new Map<string, ProgressObject>();
  function namedObject(name: string): ProgressObject {
    let entry = objects.get(name);
    if (!entry) {
      const state = createProgressState(name);
      entry = { object: new OEMUserDO(state.state, mocks.bindings), state };
      objects.set(name, entry);
    }
    return entry;
  }
  mocks.userObjects.getByName.mockImplementation((name) =>
    progressStub(name, async (input, init) =>
      namedObject(name).object.fetch(new Request(input, init)),
    ),
  );
  const { object, state } = namedObject(uid);
  const app = new Hono<AppEnv>()
    .onError(onAppError)
    .use(requestIdMiddleware)
    .route("/progress/v1", createRoutes());
  return {
    object,
    state,
    markerIndexHash,
    archiveIndexHash,
    // HTTP completion deliberately does not drain waitUntil.
    request: async (request) => {
      const url = new URL(request.url);
      const authenticated = new Request(
        `http://localhost/progress/v1${url.pathname}${url.search}`,
        request,
      );
      authenticated.headers.set("authorization", headers.authorization);
      return app.request(authenticated, undefined, mocks.bindings);
    },
  };
}
