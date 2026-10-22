// Local workerd fixture for public reads, upstream sockets, and outbox delivery.
import {
  connectEndfieldPositionSocket,
  getEndfieldPositionFromSocket,
} from "@/lib/endfieldClient/positionSocket";
import type { EndfieldDeviceProfile } from "@/lib/endfieldClient/types";
import { listCachedPublicCommentsByMarker } from "@/publicRead/origin/markerComments";
import { listCachedPublicImagesByMarker } from "@/publicRead/origin/markerImages";
import { updateBindingCredentials } from "@/repositories/binding/repository";
import type { EndfieldBindingRow } from "@/repositories/binding/types";
import { drainUserProgressStatsOutbox } from "@/services/progress/outbox";
import type { Bindings } from "@/types/app";

interface FixtureEnv {
  TEST_GATE: Fetcher;
  STATS: Fetcher;
  KV: KVNamespace;
  DB: D1Database;
}

// Only external Stats routing is substituted. Unconfigured binding access fails loudly.
function outboxBindings(env: FixtureEnv): Bindings {
  const stats = new Proxy({} as Bindings["OEM_STATS_DO"], {
    get(_target, key) {
      if (key === "getByName") {
        return () => env.STATS;
      }
      throw new Error(`Unexpected Stats namespace operation: ${String(key)}`);
    },
  });
  return new Proxy({} as Bindings, {
    get(_target, key) {
      if (key === "DB") {
        return env.DB;
      }
      if (key === "OEM_STATS_DO") {
        return stats;
      }
      throw new Error(`Unexpected outbox binding: ${String(key)}`);
    },
  });
}

interface PublicReadObservation {
  db: D1Database;
  statements: number;
}

function observePublicReads(env: FixtureEnv, request: Request): PublicReadObservation {
  const observation: PublicReadObservation = { db: env.DB, statements: 0 };
  function observeStatement(statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => observeStatement(target.bind(...values));
        }
        const value = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]) => {
          // Count executions, not prepare/bind, to preserve the cold/warm read budget.
          observation.statements++;
          if (request.headers.has("x-test-block")) {
            await env.TEST_GATE.fetch("https://gate/");
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
  }
  observation.db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => observeStatement(target.prepare(sql));
      }
      throw new Error(`Unexpected public-read database operation: ${String(key)}`);
    },
  });
  return observation;
}
const timers = new Set<unknown>();
const nativeTimeout = globalThis.setTimeout;
const nativeInterval = globalThis.setInterval;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeClearInterval = globalThis.clearInterval;
globalThis.setTimeout = ((callback: () => void, ms?: number) => {
  const id = nativeTimeout(() => {
    timers.delete(id);
    callback();
  }, ms);
  timers.add(id);
  return id;
}) as typeof setTimeout;
globalThis.setInterval = ((callback: () => void, ms?: number) => {
  const id = nativeInterval(callback, ms);
  timers.add(id);
  return id;
}) as typeof setInterval;
globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
  timers.delete(id);
  nativeClearTimeout(id);
}) as typeof clearTimeout;
globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
  timers.delete(id);
  nativeClearInterval(id);
}) as typeof clearInterval;
const args = {
  provider: "skland" as const,
  roleId: "role",
  serverId: 1,
  cred: "cred",
  token: "token",
};

export default {
  async fetch(request: Request, env: FixtureEnv, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/credential/")) {
      const binding = await env.DB.prepare(
        "SELECT * FROM endfield_bindings WHERE uid = 'user'",
      ).first<EndfieldBindingRow>();
      if (!binding) {
        throw new Error("Missing local binding fixture");
      }
      const profile = { deviceId: "new-device" } as EndfieldDeviceProfile;
      if (path.endsWith("stale")) {
        await env.DB.prepare(
          "UPDATE endfield_bindings SET token_enc = 'winner' WHERE uid = 'user'",
        ).run();
      }
      try {
        const updated = await updateBindingCredentials(env.DB, {
          uid: "user",
          binding,
          credEnc: "new-cred",
          tokenEnc: "new-token",
          deviceProfile: profile,
        });
        return Response.json({ updated: Boolean(updated) });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === "/outbox") {
      await drainUserProgressStatsOutbox(outboxBindings(env), "user");
      // A failed delivery also writes (retry/blocked). Only persisted processing is success.
      const row = await env.DB.prepare(
        "SELECT status, processed_at FROM progress_stats_outbox WHERE event_id = 'event'",
      ).first<{ status: string; processed_at: number | null }>();
      const delivered = row?.status === "processed" && row.processed_at !== null;
      return Response.json({ delivered, timers: timers.size });
    }
    if (path === "/socket" || path === "/position") {
      if (path === "/position") {
        const position = await getEndfieldPositionFromSocket(args);
        return Response.json({ position, timers: timers.size });
      }
      const controller = new AbortController();
      let subscribed!: () => void;
      const ready = new Promise<void>((resolve) => {
        subscribed = resolve;
      });
      const connection = await connectEndfieldPositionSocket(
        { ...args, signal: controller.signal },
        { onSubscribed: subscribed },
      );
      await ready;
      const active = timers.size;
      controller.abort();
      connection.close();
      return Response.json({ active, timers: timers.size });
    }
    const observation = observePublicReads(env, request);
    const payload = {
      db: observation.db,
      kv: env.KV,
      markerIds: [path.slice(1)],
      limit: 6,
      replyLimit: 3,
      assetBaseUrl: "https://assets.test",
      cacheNamespace: "prod" as const,
      waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
    };
    const items =
      request.headers.get("x-test-kind") === "comments"
        ? await listCachedPublicCommentsByMarker(payload)
        : await listCachedPublicImagesByMarker(payload);
    return Response.json({ items, statements: observation.statements });
  },
};
