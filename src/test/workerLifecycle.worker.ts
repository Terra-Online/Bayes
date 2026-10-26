// Local workerd fixture for public reads, upstream sockets, and outbox delivery.
import { Hono } from "hono";

import { runWithAuthRequest } from "@/lib/auth/betterAuth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { onAppError } from "@/middleware/error-handler";
import { requestIdMiddleware } from "@/middleware/request-id";
import { listCachedPublicCommentsByMarker } from "@/publicRead/origin/markerComments";
import { listCachedPublicImagesByMarker } from "@/publicRead/origin/markerImages";
import { updateBindingCredentials } from "@/repositories/binding/repository";
import type { EndfieldBindingRow } from "@/repositories/binding/types";
import { getNotificationById } from "@/repositories/notifications";
import { createRoutes as positionRoutes } from "@/routes/locator/positionRoutes";
import { createRoutes as notificationRoutes } from "@/routes/notify/createRoutes";
import { handleNotificationLiveUpgrade } from "@/routes/notify/liveUpgrade";
import { publishNotificationsCreated } from "@/services/notify/live";
import { invalidateBindingCaches } from "@/services/official/auth/credentialCache";
import { createEndfieldDeviceProfile } from "@/services/official/client/deviceProfile";
import {
  connectEndfieldPositionSocket,
  getEndfieldPosition,
  getEndfieldPositionFromSocket,
} from "@/services/official/client/positionSocket";
import { serializeEndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";
import type { EndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";
import { drainUserProgressStatsOutbox } from "@/services/progress/outbox";
import type { AppEnv, Bindings } from "@/types/app";

// Exercise the production entrypoint through a native service binding, rather
// than constructing a Node stand-in for WorkerEntrypoint.
export { PublicReadCache } from "@/publicRead/origin/entrypoint";
export { OEMNotificationDO } from "@/services/notify/live";

interface FixtureEnv extends Bindings {
  PUBLIC_ORIGIN: Fetcher;
  TEST_GATE: Fetcher;
  STATS: Fetcher;
  KV: KVNamespace;
  DB: D1Database;
}

// Production HTTP/auth and real notification DOs; only the remote game is replaced.
const connectionApp = new Hono<AppEnv>()
  .use("*", requestIdMiddleware)
  .onError(onAppError)
  .route("/locator", positionRoutes())
  .route("/notify/v1", notificationRoutes());

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
// Count native timers so a completed request cannot leave polling or deadlines alive.
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
const gameIdentity = {
  provider: "skland" as const,
  roleId: "role",
  serverId: 1,
  cred: "cred",
  token: "token",
};

export default {
  async fetch(request: Request, env: FixtureEnv, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/locator/") || path.startsWith("/notify/")) {
      return runWithAuthRequest(async () => {
        const upgrade = await handleNotificationLiveUpgrade(request, env);
        return upgrade ?? connectionApp.fetch(request, env, ctx);
      });
    }
    if (path === "/seed-binding") {
      // Scenario setup uses production encryption, not a second crypto implementation.
      const profile = createEndfieldDeviceProfile("native-browser-device-1234567890");
      await env.DB.prepare(
        `INSERT INTO endfield_bindings
         (uid, provider, role_id, server_id, cred_enc, token_enc, status)
         VALUES ('user', 'skland', 'role', 1, ?1, ?2, 'enabled')`,
      )
        .bind(
          await encryptSecret("cred", env.BETTER_AUTH_SECRET!),
          await encryptSecret("token", env.BETTER_AUTH_SECRET!),
        )
        .run();
      await env.DB.prepare(
        "INSERT INTO endfield_role_device_profiles (role_id, device_profile) VALUES ('role', ?1)",
      )
        .bind(serializeEndfieldDeviceProfile(profile))
        .run();
      invalidateBindingCaches(env, "user");
      return Response.json({ ok: true });
    }
    if (path.startsWith("/publish/")) {
      const notification = await getNotificationById(env.DB, path.slice("/publish/".length));
      if (!notification) {
        throw new Error("Missing notification fixture");
      }
      await publishNotificationsCreated(env, [notification]);
      return Response.json({ ok: true });
    }
    if (path === "/binding-credentials") {
      const row = await env.DB.prepare(
        "SELECT * FROM endfield_bindings WHERE uid = 'user'",
      ).first<EndfieldBindingRow>();
      if (!row) {
        throw new Error("Missing binding fixture");
      }
      return Response.json({
        cred: await decryptSecret(row.cred_enc, env.BETTER_AUTH_SECRET!),
        token: await decryptSecret(row.token_enc, env.BETTER_AUTH_SECRET!),
      });
    }
    if (path === "/timers") {
      return Response.json({ timers: timers.size });
    }
    if (path === "/position-fallback") {
      return Response.json({
        position: await getEndfieldPosition(gameIdentity),
        timers: timers.size,
      });
    }
    if (path === "/position-attempt" || path === "/position-fallback-attempt") {
      try {
        const position =
          path === "/position-fallback-attempt"
            ? await getEndfieldPosition(gameIdentity)
            : await getEndfieldPositionFromSocket(gameIdentity, 100);
        return Response.json({ position, timers: timers.size });
      } catch (error) {
        if (!(error instanceof ApiError)) {
          throw error;
        }
        return Response.json({
          error: { code: error.code, status: error.status, details: error.details },
          timers: timers.size,
        });
      }
    }
    if (path.startsWith("/origin/")) {
      const url = new URL(request.url);
      url.pathname = path.slice("/origin".length);
      return env.PUBLIC_ORIGIN.fetch(new Request(url, request));
    }
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
        const position = await getEndfieldPositionFromSocket(gameIdentity);
        return Response.json({ position, timers: timers.size });
      }
      const controller = new AbortController();
      let subscribed!: () => void;
      const ready = new Promise<void>((resolve) => {
        subscribed = resolve;
      });
      const connection = await connectEndfieldPositionSocket(
        { ...gameIdentity, signal: controller.signal },
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
