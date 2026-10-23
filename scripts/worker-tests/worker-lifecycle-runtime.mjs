import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateNativeDatabase } from "./native-test-database.mjs";
import {
  bundleFixture,
  compatibility,
  deferred,
  Miniflare,
  within,
} from "./worker-test-runtime.mjs";

export async function createLifecycleRuntime(t) {
  const temporary = await mkdtemp(join(tmpdir(), "bayes-lifecycle-regression-"));
  let worker;
  const gate = { blocked: deferred(), released: deferred() };
  t.after(async () => {
    gate.released.resolve();
    try {
      await worker?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  const fixture = await bundleFixture(temporary, "workerLifecycle");
  worker = new Miniflare({
    workers: [
      {
        name: "main",
        ...fixture,
        kvNamespaces: { KV: "lifecycle-kv", OEM_KV: "lifecycle-kv" },
        d1Databases: { DB: "local-lifecycle" },
        bindings: {
          BETTER_AUTH_URL: "http://localhost",
          BETTER_AUTH_SECRET: "native-lifecycle-secret-at-least-32-characters",
          GOOGLE_CLIENT_ID: "local-google",
          GOOGLE_CLIENT_SECRET: "local-google-secret",
          GITHUB_CLIENT_ID: "local-github",
          GITHUB_CLIENT_SECRET: "local-github-secret",
          DISCORD_CLIENT_ID: "local-discord",
          DISCORD_CLIENT_SECRET: "local-discord-secret",
        },
        ratelimits: {
          OEM_AUTH_RATE_LIMIT: { namespace_id: "100", simple: { limit: 1000, period: 60 } },
        },
        durableObjects: {
          OEM_NOTIFICATION_DO: { className: "OEMNotificationDO", useSQLite: true },
        },
        outboundService: "upstream",
        serviceBindings: {
          PUBLIC_ORIGIN: { name: "main", entrypoint: "PublicReadCache" },
          TEST_GATE: async () => {
            gate.blocked.resolve();
            await gate.released.promise;
            return new Response("released");
          },
          STATS: async () => Response.json({ applied: true }),
        },
      },
      {
        name: "upstream",
        ...compatibility,
        modules: true,
        outboundService: () => {
          throw new Error("Unexpected external request in local lifecycle test");
        },
        script: await readFile(
          new URL("./worker-lifecycle-game-provider.mjs", import.meta.url),
          "utf8",
        ),
      },
    ],
  });
  const read = async (path, headers) => {
    const response = await within(
      worker.dispatchFetch(`https://fixture.test/${path}`, { headers }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const connect = async (path, headers) => {
    // Exercise the browser-style HTTP upgrade over a real local connection.
    const url = new URL(path, await worker.ready);
    url.protocol = "ws:";
    url.searchParams.set("access_token", headers.authorization.slice("Bearer ".length));
    const socket = new WebSocket(url);
    const messages = [];
    let pendingMessage;
    const opened = deferred();
    const closed = deferred();
    socket.addEventListener("open", () => opened.resolve());
    socket.addEventListener("message", (event) => {
      if (pendingMessage) {
        pendingMessage.resolve(event.data);
        pendingMessage = undefined;
      } else {
        messages.push(event.data);
      }
    });
    socket.addEventListener("close", (event) => closed.resolve(event));
    await within(opened.promise);
    return {
      socket,
      closed: closed.promise,
      next: async () => {
        if (messages.length) {
          return messages.shift();
        }
        assert.equal(pendingMessage, undefined, "Only one pending message read per socket");
        pendingMessage = deferred();
        return within(pendingMessage.promise);
      },
    };
  };

  const db = await worker.getD1Database("DB", "main");
  await migrateNativeDatabase(db);
  await db
    .prepare(
      "INSERT INTO users (uid, email, password_hash, nickname) VALUES ('user', 'native@example.test', '', 'NativeUser')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users (id, email, name, emailVerified) VALUES ('user', 'native@example.test', 'NativeUser', 1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_sessions (id, userId, token, expiresAt, createdAt, updatedAt) VALUES ('native-session', 'user', 'native-token', ?1, ?2, ?2)",
    )
    .bind(new Date(Date.now() + 86400000).toISOString(), new Date().toISOString())
    .run();
  const authHeaders = { authorization: "Bearer native-token" };

  return { worker, db, read, connect, authHeaders, gate };
}
