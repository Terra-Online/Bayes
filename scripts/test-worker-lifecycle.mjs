import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  bundleFixture,
  compatibility,
  deferred,
  Miniflare,
  within,
} from "./worker-test-runtime.mjs";

const temporary = await mkdtemp(join(tmpdir(), "bayes-lifecycle-regression-"));
try {
  const fixture = await bundleFixture(temporary, "workerLifecycle");
  await test("native Workers public-read and connection lifetimes", async (t) => {
    let blocked = deferred();
    let released = deferred();
    const worker = new Miniflare({
      workers: [
        {
          name: "main",
          ...fixture,
          kvNamespaces: ["KV"],
          d1Databases: { DB: "local-lifecycle" },
          outboundService: "upstream",
          serviceBindings: {
            TEST_GATE: async () => {
              blocked.resolve();
              await released.promise;
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
          script: `export default { fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/api/v1/websocket/token') return Response.json({ code: 0, data: { token: 'local-token' } });
        if (path !== '/ws/v1/game/endfield/map') return new Response('Unknown fixture route', { status: 404 });
        const pair = new WebSocketPair(); const [client, server] = Object.values(pair); server.accept();
        server.addEventListener('message', event => {
          const { type } = JSON.parse(event.data);
          if (type === 1) server.send(JSON.stringify({ type: 2 }));
          if (type === 1011) server.send(JSON.stringify({ type: 1012, data: { pos: { x: 1, y: 2, z: 3 }, levelId: 'level', isOnline: true, mapId: 'map' } }));
        });
        return new Response(null, { status: 101, webSocket: client });
      } };`,
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
    try {
      for (const kind of ["images", "comments"]) {
        await t.test(`${kind}: independent cold reads and completed KV reuse`, async () => {
          const first = read(`${kind}-cold`, { "x-test-kind": kind, "x-test-block": "1" });
          await within(blocked.promise);
          try {
            assert.deepEqual(await read(`${kind}-cold`, { "x-test-kind": kind }), {
              items: [],
              statements: 1,
            });
          } finally {
            released.resolve();
          }
          assert.deepEqual(await first, { items: [], statements: 1 });
          assert.deepEqual(await read(`${kind}-cold`, { "x-test-kind": kind }), {
            items: [],
            statements: 0,
          });
          blocked = deferred();
          released = deferred();
        });
      }
      await t.test("subscribed sockets release both intervals immediately on abort", async () => {
        assert.deepEqual(await read("socket"), { active: 2, timers: 0 });
      });
      await t.test("one-shot positions close the upstream socket and all deadlines", async () => {
        assert.deepEqual(await read("position"), {
          position: { pos: { x: 1, y: 2, z: 3 }, levelId: "level", isOnline: true, mapId: "map" },
          timers: 0,
        });
      });
      await t.test("outbox acknowledgements clear the ten-second deadline", async () => {
        assert.deepEqual(await read("outbox"), { delivered: true, timers: 0 });
      });
      const db = await worker.getD1Database("DB", "main");
      await db
        .prepare(
          "CREATE TABLE endfield_bindings (uid TEXT PRIMARY KEY, provider TEXT, role_id TEXT, server_id INTEGER, cred_enc TEXT, token_enc TEXT, status TEXT, updated_at TEXT)",
        )
        .run();
      await db
        .prepare(
          "CREATE TABLE endfield_role_device_profiles (role_id TEXT PRIMARY KEY, device_profile TEXT, updated_at TEXT)",
        )
        .run();
      for (const mode of ["success", "stale", "rollback"]) {
        await t.test(`native D1 credential/profile transaction: ${mode}`, async () => {
          await db.prepare("DELETE FROM endfield_bindings").run();
          await db.prepare("DELETE FROM endfield_role_device_profiles").run();
          await db
            .prepare(
              "INSERT INTO endfield_bindings VALUES ('user', 'skland', 'role', 1, 'cred', 'token', 'enabled', 'old')",
            )
            .run();
          if (mode === "rollback") {
            await db
              .prepare(
                "CREATE TRIGGER reject_profile BEFORE INSERT ON endfield_role_device_profiles BEGIN SELECT RAISE(ABORT, 'profile write rejected'); END",
              )
              .run();
          }
          const result = await read(`credential/${mode}`);
          const row = await db.prepare("SELECT token_enc FROM endfield_bindings").first();
          const profile = await db
            .prepare("SELECT device_profile FROM endfield_role_device_profiles")
            .first();
          if (mode === "rollback") {
            assert.match(result.error, /profile write rejected/);
            assert.equal(row.token_enc, "token");
            assert.equal(profile, null);
          } else {
            assert.deepEqual(result, { updated: mode === "success" });
            assert.equal(row.token_enc, mode === "success" ? "new-token" : "winner");
            assert.equal(Boolean(profile), mode === "success");
          }
        });
      }
    } finally {
      released.resolve();
      await worker.dispose();
    }
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
