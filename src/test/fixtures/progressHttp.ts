import { Hono } from "hono";
import { expect } from "vitest";

import { sha256Hex } from "@/lib/crypto";
import { onAppError } from "@/middleware/error-handler";
import { PublicReadCache } from "@/publicRead/origin/entrypoint";
import { createRoutes } from "@/routes/progress/createRoutes";
import { buildCanonicalArchiveManifest } from "@/services/progress/archiveManifest";
import { buildCanonicalMarkerManifest } from "@/services/progress/manifest";
import { OEMStatsDO } from "@/services/progress/statsDo";
import { OEMUserDO } from "@/services/progress/userDo";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { AppEnv } from "@/types/app";

import { insertAuthUser, insertSession, testAuthConfig } from "./auth";
import { createProgressTestState, type ProgressTestState } from "./progressRuntime";
import { insertUser } from "./users";

type ProgressKind = "map" | "archive";
type ProgressStatsDelivery = (request: Request, object: OEMStatsDO) => Promise<Response>;
interface ProgressRead {
  revision: string;
  pointIds?: string[];
  archiveIds?: string[];
}
interface AcceptedProgressSync {
  ok: boolean;
  progress: { revision: string };
  unchanged?: boolean;
}
interface PublicProgressStats {
  counts: string;
  sampleSize: number;
  totalSyncedUsers: number;
  pointCount: number;
  markerIndexHash: string;
}
export interface ProgressHttpFixture {
  database: TestDatabase;
  sessions: Record<string, { authorization: string }>;
  env: AppEnv["Bindings"];
  users: Map<string, OEMUserDO>;
  stats: Map<string, OEMStatsDO>;
  kv: Map<string, string>;
  statsDelivery: ProgressStatsDelivery;
  publicCache: PublicReadCache;
  drainStatsDeliveries(): Promise<void>;
  request(path: string, body?: unknown, user?: string | null): Response | Promise<Response>;
  registerManifest(kind?: ProgressKind, ids?: string[]): Promise<string>;
  readProgress(hash: string, kind?: ProgressKind, user?: string): Promise<ProgressRead>;
  syncProgress(
    hash: string,
    mutationId: string,
    patch?: Record<string, unknown>,
    kind?: ProgressKind,
    user?: string,
  ): Response | Promise<Response>;
  expectAcceptedSync(response: Response): Promise<AcceptedProgressSync>;
  readPublicStats(
    hash: string,
  ): Promise<{ response: Response; body: PublicProgressStats; counts: number[] }>;
}

export async function buildManifestPayload(kind: ProgressKind, ids: string[]) {
  const hash = await sha256Hex(
    kind === "map" ? buildCanonicalMarkerManifest(ids) : buildCanonicalArchiveManifest(ids),
  );
  return kind === "map"
    ? { markerIndexHash: hash, pointIds: ids }
    : { archiveIndexHash: hash, archiveIds: ids };
}

export function createProgressHttpFixture(): ProgressHttpFixture {
  let env: AppEnv["Bindings"];

  const database = createTestDatabase();
  const sessions: Record<string, { authorization: string }> = {};
  for (const [uid, uidNumber] of [
    ["explorer", 100001],
    ["other", 100002],
  ] as const) {
    insertUser(database.sqlite, { uid, uid_number: uidNumber });
    insertAuthUser(database.sqlite, { id: uid });
    sessions[uid] = insertSession(database.sqlite, { userId: uid }).headers;
  }
  const users = new Map<string, OEMUserDO>();
  const stats = new Map<string, OEMStatsDO>();
  const statsStates = new Map<string, ProgressTestState>();
  const pendingStatsDeliveries: Promise<unknown>[] = [];
  const kv = new Map<string, string>();
  let statsDelivery: ProgressStatsDelivery = (request, object) => object.fetch(request);
  const getStats = (name: string) => {
    let object = stats.get(name);
    if (!object) {
      let runtime = statsStates.get(name);
      if (!runtime) {
        runtime = createProgressTestState(name);
        statsStates.set(name, runtime);
      }
      object = new OEMStatsDO(runtime.state, env);
      stats.set(name, object);
    }
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        statsDelivery(new Request(input, init), object),
    };
  };
  env = {
    ...testAuthConfig,
    DB: database.db,
    LOCK_PROGRESS_ENDPOINTS: "false",
    OEM_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
    OEM_USER_DO: {
      getByName: (name: string) => {
        let object = users.get(name);
        if (!object) {
          const runtime = createProgressTestState(name);
          // Each named object has independent storage and a production queue.
          runtime.state.waitUntil = (work) => {
            pendingStatsDeliveries.push(work);
          };
          object = new OEMUserDO(runtime.state, env);
          users.set(name, object);
        }
        return { fetch: (request: Request) => object.fetch(request) };
      },
    },
    OEM_STATS_DO: { getByName: getStats, idFromName: (name: string) => name, get: getStats },
  } as unknown as AppEnv["Bindings"];
  const publicCache = new PublicReadCache({} as ExecutionContext, env);

  async function drainStatsDeliveries() {
    while (pendingStatsDeliveries.length) {
      await Promise.all(pendingStatsDeliveries.splice(0));
    }
  }

  function request(path: string, body?: unknown, user: string | null = "explorer") {
    const app = new Hono<AppEnv>().onError(onAppError).route("/progress/v1", createRoutes());
    return app.request(
      `http://localhost/progress/v1${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(user ? sessions[user] : {}), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  }

  async function registerManifest(kind: "map" | "archive" = "map", ids = ["p1", "p2"]) {
    const manifest = await buildManifestPayload(kind, ids);
    const response = await request(kind === "map" ? "/manifest" : "/archive/manifest", manifest);
    expect(response.status).toBe(200);
    return ("markerIndexHash" in manifest ? manifest.markerIndexHash : manifest.archiveIndexHash)!;
  }

  async function readProgress(hash: string, kind: "map" | "archive" = "map", user = "explorer") {
    const response = await request(
      kind === "map" ? `/state?markerIndexHash=${hash}` : `/archive/state?archiveIndexHash=${hash}`,
      undefined,
      user,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { progress: ProgressRead }).progress;
  }

  function syncProgress(
    hash: string,
    mutationId: string,
    patch: Record<string, unknown> = {},
    kind: "map" | "archive" = "map",
    user = "explorer",
  ) {
    return request(
      kind === "map" ? "/sync?uid=other" : "/archive/sync?uid=other",
      {
        baseRevision: "",
        clientMutationId: mutationId,
        [kind === "map" ? "markerIndexHash" : "archiveIndexHash"]: hash,
        updatedAt: 1_700_000_000_000,
        ...patch,
      },
      user,
    );
  }

  async function expectAcceptedSync(response: Response): Promise<AcceptedProgressSync> {
    expect(response.status).toBe(200);
    return response.json();
  }

  async function readPublicStats(hash: string) {
    const response = await request(`/stats?markerIndexHash=${hash}`, undefined, null);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PublicProgressStats;
    const bytes = Buffer.from(body.counts, "base64");
    return {
      response,
      body,
      counts: Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readUInt32LE(index * 4)),
    };
  }
  return {
    database,
    env,
    sessions,
    users,
    stats,
    kv,
    publicCache,
    drainStatsDeliveries,
    request,
    registerManifest,
    readProgress,
    syncProgress,
    expectAcceptedSync,
    readPublicStats,
    get statsDelivery() {
      return statsDelivery;
    },
    set statsDelivery(deliver: ProgressStatsDelivery) {
      statsDelivery = deliver;
    },
  };
}
