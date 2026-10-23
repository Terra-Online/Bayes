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

import { createProgressTestState, type ProgressTestState } from "./progressRuntime";

interface ProgressObject {
  object: OEMUserDO;
  state: ProgressTestState;
}

export interface ProgressFixture {
  request: (request: Request) => Promise<Response>;
  object: OEMUserDO;
  markerIndexHash: string;
  archiveIndexHash: string;
  state: ProgressTestState;
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
      const state = createProgressTestState(name);
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
