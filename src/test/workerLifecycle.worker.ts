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

type FixtureEnv = { TEST_GATE: Fetcher; STATS: Fetcher; KV: KVNamespace; DB: D1Database };
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
      let delivered = false;
      const db = {
        prepare: () => ({
          bind() {
            return this;
          },
          all: async () => ({
            results: delivered
              ? []
              : [
                  {
                    id: 1,
                    event_id: "event",
                    uid: "user",
                    mutation_id: "mutation",
                    marker_index_hash: "hash",
                    payload: JSON.stringify({
                      eventId: "event",
                      markerIndexHash: "hash",
                      pointCount: 1,
                      increments: [0],
                      decrements: [],
                      firstSync: true,
                    }),
                    attempts: 0,
                    created_at: 0,
                  },
                ],
          }),
          run: async () => {
            delivered = true;
          },
        }),
      } as unknown as D1Database;
      await drainUserProgressStatsOutbox(
        { DB: db, OEM_STATS_DO: { getByName: () => env.STATS } } as unknown as Bindings,
        "user",
      );
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
    let statements = 0;
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        all: async () => {
          statements++;
          if (request.headers.has("x-test-block")) {
            await env.TEST_GATE.fetch("https://gate/");
          }
          return { results: [] };
        },
      }),
    } as unknown as D1Database;
    const payload = {
      db,
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
    return Response.json({ items, statements });
  },
};
