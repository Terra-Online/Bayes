import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { migrateNativeDatabase } from "./native-test-database.mjs";
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
          script: `let mode = 'position'; let rejected = false; let refreshFailed = false; let recovered = false;
          export default { async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/test/mode') { mode = await request.text(); rejected = false; refreshFailed = false; recovered = false; return new Response('ok'); }
        if (path === '/web/v1/auth/refresh') {
          if (mode === 'upgrade-rejected' && !refreshFailed) { refreshFailed = true; return Response.json({ code: 1 }, { status: 503 }); }
          recovered = true;
          return Response.json({ code: 0, data: { token: 'renewed-token' } });
        }
        if (path === '/api/v1/websocket/token') {
          if (mode === 'transport-error' && !rejected) { rejected = true; throw new Error('Game peer connection lost'); }
          if (mode === 'token-down' && !rejected) { rejected = true; return Response.json({ code: 1 }, { status: 503 }); }
          return Response.json({ code: 0, data: { token: 'local-token' } });
        }
        if (path === '/web/v1/game/endfield/map/me/position') {
          if (mode === 'http-down' || mode === 'fallback-expired') return Response.json({ code: 1 }, { status: 503 });
          return Response.json({ code: 0, data: { pos: { x: 9, y: 0, z: 8 }, levelId: 'http-level', isOnline: true, mapId: 'map' } });
        }
        if (path !== '/ws/v1/game/endfield/map') return new Response('Unknown fixture route', { status: 404 });
        if (mode === 'upgrade-rejected' && !recovered) return new Response('Credential rejected', { status: 401 });
        const query = new URL(request.url).searchParams;
        if (query.get('roleId') !== 'role' || query.get('serverId') !== '1') return new Response('Wrong game role', { status: 422 });
        const pair = new WebSocketPair(); const [client, server] = Object.values(pair); server.accept();
        server.addEventListener('message', event => {
          const { type, data } = JSON.parse(event.data);
          if (type === 1) {
            if (data.token !== 'local-token') { server.close(1008, 'Wrong socket token'); return; }
            server.send(JSON.stringify({ type: 2 }));
          }
          if (type === 1011) {
            if (mode === 'silent') return;
            if (mode === 'device-rejected') { server.send(JSON.stringify({ type: 1012, data: { code: 10001, message: 'Device rejected' } })); return; }
            if (mode === 'expired' || mode === 'fallback-expired') {
              server.send(JSON.stringify({ type: 1012, data: { code: '10002', message: 'Game login expired' } }));
              return;
            }
            if (mode === 'refresh' && !rejected) {
              rejected = true;
              server.send(JSON.stringify({ type: 1012, data: { code: 10000 } }));
            } else {
              server.send('not JSON');
              server.send(JSON.stringify({ type: 1012, data: { pos: { x: 'not-a-coordinate', z: 3 }, levelId: 'level', isOnline: true, mapId: 'map' } }));
              server.send(JSON.stringify({ type: 1012, data: { pos: { x: 1, y: 2, z: 3 }, levelId: 'level', isOnline: true, mapId: 'map' } }));
            }
          }
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
    const connect = async (path, headers) => {
      // Exercise the browser-style HTTP upgrade over a real local connection.
      const url = new URL(path, await worker.ready);
      url.protocol = "ws:";
      url.searchParams.set("access_token", headers.authorization.slice("Bearer ".length));
      const socket = new WebSocket(url);
      const messages = [];
      let pending;
      const opened = deferred();
      const closed = deferred();
      socket.addEventListener("open", () => opened.resolve());
      socket.addEventListener("message", (event) => {
        if (pending) {
          pending.resolve(event.data);
          pending = undefined;
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
          assert.equal(pending, undefined, "Only one pending message read per socket");
          pending = deferred();
          return within(pending.promise);
        },
      };
    };
    try {
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
      await t.test(
        "locator: a real ticket upgrades, bridges the game and warms the owner's position",
        async () => {
          await read("seed-binding");
          const initial = await read("locator/position?socket_ticket=1", authHeaders);
          assert.deepEqual(initial.data.pos, { x: 9, y: 0, z: 8 });
          const response = await within(
            worker.dispatchFetch(
              `https://fixture.test/locator/position-stream?binding=1&ticket=${encodeURIComponent(initial.socketTicket)}`,
              {
                headers: { upgrade: "websocket" },
              },
            ),
          );
          assert.equal(response.status, 101);
          const socket = response.webSocket;
          assert.ok(socket);
          const received = [];
          const position = deferred();
          const closed = deferred();
          socket.addEventListener("message", (event) => {
            const frame = JSON.parse(event.data);
            received.push(frame);
            if (frame.type === "position") {
              position.resolve(frame);
            }
          });
          socket.addEventListener("close", (event) => closed.resolve(event));
          socket.accept();
          try {
            const frame = await within(position.promise);
            assert.deepEqual(frame.data, {
              pos: { x: 1, y: 2, z: 3 },
              levelId: "level",
              isOnline: true,
              mapId: "map",
            });
            assert.equal(frame.binding.roleId, "role");
            assert.deepEqual(
              received.filter((item) => item.type === "status").map((item) => item.status),
              ["connecting", "connected"],
            );
            const warm = await read("locator/position", authHeaders);
            assert.deepEqual(warm, { data: frame.data });
            const unauthorized = await worker.dispatchFetch(
              "https://fixture.test/locator/position",
            );
            assert.equal(unauthorized.status, 401);
            // Ordinary browser messages are ignored; the close command remains usable.
            socket.send("not a locator command");
            socket.send("close");
            const ended = await within(closed.promise);
            assert.equal(ended.code, 1000);
            assert.equal(ended.reason, "closed");
            assert.deepEqual(await read("timers"), { timers: 0 });
          } finally {
            socket.close();
            await db.prepare("DELETE FROM endfield_bindings").run();
            await db.prepare("DELETE FROM endfield_role_device_profiles").run();
          }
        },
      );
      await t.test(
        "notifications: persisted fanout reaches each owner tab and reconnect recovers unread state",
        async () => {
          await db
            .prepare(
              "INSERT INTO users (uid, email, password_hash, nickname) VALUES ('neighbor', 'neighbor@example.test', '', 'Neighbor')",
            )
            .run();
          await db
            .prepare(
              "INSERT INTO auth_users (id, email, name, emailVerified) VALUES ('neighbor', 'neighbor@example.test', 'Neighbor', 1)",
            )
            .run();
          await db
            .prepare(
              "INSERT INTO auth_sessions (id, userId, token, expiresAt, createdAt, updatedAt) VALUES ('neighbor-session', 'neighbor', 'neighbor-token', ?1, ?2, ?2)",
            )
            .bind(new Date(Date.now() + 86400000).toISOString(), new Date().toISOString())
            .run();
          const neighborHeaders = { authorization: "Bearer neighbor-token" };
          const first = await connect("notify/v1/live?clientId=browser", authHeaders);
          const tab = await connect("notify/v1/live?clientId=another-tab", authHeaders);
          const neighbor = await connect("notify/v1/live?clientId=browser", neighborHeaders);
          const sockets = [first, tab, neighbor];
          try {
            for (const connection of sockets) {
              assert.deepEqual(JSON.parse(await connection.next()), {
                event: "notification.ready",
                unread: { system: 0, community: 0, total: 0 },
              });
            }
            for (const [id, uid] of [
              ["owner-notification", "user"],
              ["neighbor-notification", "neighbor"],
            ]) {
              await db
                .prepare(
                  "INSERT INTO notifications (id, recipient_user_id, category, type, dedupe_key) VALUES (?1, ?2, 'system', 'system.submission.approved', ?1)",
                )
                .bind(id, uid)
                .run();
              await read(`publish/${id}`);
            }
            for (const connection of [first, tab]) {
              const delivered = JSON.parse(await connection.next());
              assert.equal(delivered.event, "notification.upserted");
              assert.equal(delivered.notification.id, "owner-notification");
              assert.deepEqual(delivered.unread, { system: 1, community: 0, total: 1 });
            }
            // A later recipient-specific event is a fence: a leaked owner event would be read first.
            assert.equal(
              JSON.parse(await neighbor.next()).notification.id,
              "neighbor-notification",
            );
            const replacement = await connect("notify/v1/live?clientId=browser", authHeaders);
            sockets.push(replacement);
            assert.deepEqual(JSON.parse(await replacement.next()), {
              event: "notification.ready",
              unread: { system: 1, community: 0, total: 1 },
            });
            // Both platform auto-response and nonce heartbeat work on native accepted sockets.
            replacement.socket.send("OEMping1");
            assert.equal(await replacement.next(), "OEMping1");
            replacement.socket.send(new Uint8Array([1, 2, 3]));
            replacement.socket.send("unknown command");
            replacement.socket.send("Ab123456");
            assert.equal(await replacement.next(), "Ab123456");
            const inbox = await read("notify/v1/system/messages", authHeaders);
            assert.deepEqual(
              inbox.items.map((item) => item.id),
              ["owner-notification"],
            );
            assert.equal(inbox.unread.total, 1);
            assert.equal(
              (
                await db
                  .prepare("SELECT read_at FROM notifications WHERE id = 'owner-notification'")
                  .first()
              ).read_at,
              null,
            );
            replacement.socket.send("close");
            // A replacement must leave the other tab alive.
            tab.socket.send("Cd123456");
            assert.equal(await tab.next(), "Cd123456");
          } finally {
            for (const connection of sockets) {
              if (connection.socket.readyState === 1) {
                connection.socket.close(1000);
              }
            }
          }
        },
      );
      await t.test(
        "locator: a rejected stream refreshes saved credentials and reconnects without dropping the browser",
        async () => {
          const game = await worker.getWorker("upstream");
          await game.fetch("https://game.test/test/mode", { method: "POST", body: "refresh" });
          await read("seed-binding");
          const before = await db
            .prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'")
            .first();
          const stream = await connect("locator/position-stream", authHeaders);
          const frames = [];
          try {
            for (let count = 0; count < 8; count++) {
              const frame = JSON.parse(await stream.next());
              frames.push(frame);
              if (frame.type === "position") {
                break;
              }
            }
            assert.ok(
              frames.some(
                (frame) =>
                  frame.status === "reconnecting" && frame.reason === "refreshing credentials",
              ),
            );
            assert.equal(frames.filter((frame) => frame.status === "connected").length, 2);
            assert.deepEqual(frames.at(-1), {
              type: "position",
              data: { pos: { x: 1, y: 2, z: 3 }, levelId: "level", isOnline: true, mapId: "map" },
            });
            const after = await db
              .prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'")
              .first();
            assert.notEqual(after.token_enc, before.token_enc);
            assert.deepEqual(await read("binding-credentials"), {
              cred: "cred",
              token: "renewed-token",
            });
            for (const key of ["role_id", "server_id", "provider", "status"]) {
              assert.equal(after[key], before[key]);
            }
            stream.socket.send("close");
            assert.equal((await within(stream.closed)).code, 1000);
            assert.deepEqual(await read("timers"), { timers: 0 });
          } finally {
            if (stream.socket.readyState === 1) {
              stream.socket.close(1000);
            }
            await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
            await db.prepare("DELETE FROM endfield_bindings").run();
            await db.prepare("DELETE FROM endfield_role_device_profiles").run();
          }
        },
      );
      await t.test(
        "locator: an expired game login reports rebinding without replacing saved credentials",
        async () => {
          const game = await worker.getWorker("upstream");
          await game.fetch("https://game.test/test/mode", { method: "POST", body: "expired" });
          await read("seed-binding");
          const before = await db
            .prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'")
            .first();
          const stream = await connect("locator/position-stream", authHeaders);
          try {
            let frame;
            for (let count = 0; count < 8; count++) {
              frame = JSON.parse(await stream.next());
              if (frame.type === "error") {
                break;
              }
            }
            assert.equal(frame.error.status, 401);
            assert.equal(frame.error.code, "ENDFIELD_CREDENTIAL_REJECTED");
            assert.equal(frame.error.details.upstreamCode, 10002);
            assert.equal(frame.error.requestId, frame.requestId);
            assert.deepEqual(
              await db.prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'").first(),
              before,
            );
            stream.socket.send("close");
            assert.equal((await within(stream.closed)).code, 1000);
            assert.deepEqual(await read("timers"), { timers: 0 });
          } finally {
            if (stream.socket.readyState === 1) {
              stream.socket.close(1000);
            }
            await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
            await db.prepare("DELETE FROM endfield_bindings").run();
            await db.prepare("DELETE FROM endfield_role_device_profiles").run();
          }
        },
      );
      await t.test(
        "locator: rejected upgrade preserves the binding when refresh fails and a new browser connection recovers",
        async () => {
          const game = await worker.getWorker("upstream");
          await game.fetch("https://game.test/test/mode", {
            method: "POST",
            body: "upgrade-rejected",
          });
          await read("seed-binding");
          const before = await db
            .prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'")
            .first();
          const first = await connect("locator/position-stream", authHeaders);
          let retry;
          try {
            let error;
            for (let count = 0; count < 8; count++) {
              const frame = JSON.parse(await first.next());
              if (frame.type === "error") {
                error = frame.error;
                break;
              }
            }
            assert.equal(error.code, "ENDFIELD_POSITION_SOCKET_UNAVAILABLE");
            assert.equal(error.status, 401);
            assert.deepEqual(
              await db.prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'").first(),
              before,
            );
            first.socket.send("close");
            assert.equal((await within(first.closed)).code, 1000);
            retry = await connect("locator/position-stream", authHeaders);
            let position;
            for (let count = 0; count < 8; count++) {
              const frame = JSON.parse(await retry.next());
              if (frame.type === "position") {
                position = frame.data;
                break;
              }
            }
            assert.deepEqual(position, {
              pos: { x: 1, y: 2, z: 3 },
              levelId: "level",
              isOnline: true,
              mapId: "map",
            });
            assert.deepEqual(await read("binding-credentials"), {
              cred: "cred",
              token: "renewed-token",
            });
            retry.socket.send("close");
            assert.equal((await within(retry.closed)).code, 1000);
            assert.deepEqual(await read("timers"), { timers: 0 });
          } finally {
            for (const stream of [first, retry]) {
              if (stream?.socket.readyState === 1) {
                stream.socket.close(1000);
              }
            }
            await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
            await db.prepare("DELETE FROM endfield_bindings").run();
            await db.prepare("DELETE FROM endfield_role_device_profiles").run();
          }
        },
      );
      for (const [mode, status, code] of [
        ["token-down", 502, "ENDFIELD_UPSTREAM_REJECTED"],
        ["transport-error", 500, "LOCATOR_STREAM_ERROR"],
      ]) {
        await t.test(
          `locator: ${mode} reports an error then reconnects with the same binding`,
          async () => {
            const game = await worker.getWorker("upstream");
            await game.fetch("https://game.test/test/mode", { method: "POST", body: mode });
            await read("seed-binding");
            const before = await db
              .prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'")
              .first();
            const stream = await connect("locator/position-stream", authHeaders);
            const frames = [];
            try {
              for (let count = 0; count < 8; count++) {
                const frame = JSON.parse(await stream.next());
                frames.push(frame);
                if (frame.type === "position") {
                  break;
                }
              }
              const error = frames.find((frame) => frame.type === "error");
              assert.equal(error.error.status, status);
              assert.equal(error.error.code, code);
              assert.equal(error.error.requestId, error.requestId);
              assert.ok(frames.some((frame) => frame.status === "connected"));
              assert.equal(frames.at(-1).type, "position");
              assert.deepEqual(
                await db.prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'").first(),
                before,
              );
              stream.socket.send("close");
              assert.equal((await within(stream.closed)).code, 1000);
              assert.deepEqual(await read("timers"), { timers: 0 });
            } finally {
              if (stream.socket.readyState === 1) {
                stream.socket.close(1000);
              }
              await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
              await db.prepare("DELETE FROM endfield_bindings").run();
              await db.prepare("DELETE FROM endfield_role_device_profiles").run();
            }
          },
        );
      }
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
      await t.test(
        "image origin: native GET and HEAD retain payload, cache policy and purge tags",
        async () => {
          await db
            .prepare(
              `INSERT INTO ugc_submissions
             (id, kind, poi_id, poi_hash, poi_type, snapshot_id, user_id, file_path, status)
             VALUES ('native-image', 'image', 'origin-image', 'hash', 'poi', 'native-image-snapshot', 'user', 'images/native.webp', 'active')`,
            )
            .run();
          const url =
            "https://fixture.test/origin/images?markerId=origin-image&limit=6&namespace=default&assetBaseUrl=https://assets.test";
          const get = await within(worker.dispatchFetch(url));
          assert.equal(get.status, 200);
          assert.equal(get.headers.get("content-type"), "application/json; charset=utf-8");
          assert.match(get.headers.get("cache-control"), /^public, max-age=\d+$/);
          assert.match(get.headers.get("cloudflare-cdn-cache-control"), /^public, max-age=\d+$/);
          assert.equal(get.headers.get("x-oem-marker-kv-cache"), "enabled");
          assert.ok(get.headers.get("cache-tag"));
          const payload = await get.json();
          assert.equal(payload.items.length, 1);
          assert.equal(payload.items[0].id, "native-image");
          assert.equal(payload.items[0].url, "https://assets.test/images/native.webp");

          const head = await within(worker.dispatchFetch(url, { method: "HEAD" }));
          assert.equal(head.status, 200);
          for (const header of [
            "cache-control",
            "cloudflare-cdn-cache-control",
            "cache-tag",
            "x-oem-marker-kv-cache",
          ]) {
            assert.equal(head.headers.get(header), get.headers.get(header));
          }
          assert.equal(await head.text(), "");

          const empty = await within(
            worker.dispatchFetch(url.replace("origin-image", "origin-empty-image")),
          );
          assert.deepEqual(await empty.json(), { items: [] });
          assert.match(empty.headers.get("cache-control"), /^public, max-age=\d+$/);
          assert.match(empty.headers.get("cloudflare-cdn-cache-control"), /^public, max-age=\d+$/);
        },
      );
      await t.test(
        "comment origin: native GET and HEAD retain a bounded thread and positive/empty cache policy",
        async () => {
          for (const [id, parentId, depth] of [
            ["native-comment", null, 0],
            ["native-reply", "native-comment", 1],
            ["native-reply-2", "native-comment", 1],
          ]) {
            await db
              .prepare(
                `INSERT INTO ugc_submissions
               (id, kind, poi_id, poi_hash, poi_type, snapshot_id, user_id, content, status, parent_id, comment_depth)
               VALUES (?1, 'comment', 'origin-comment', 'hash', 'poi', ?2, 'user', ?3, 'active', ?4, ?5)`,
              )
              .bind(id, `${id}-snapshot`, `Content ${id}`, parentId, depth)
              .run();
          }
          const url =
            "https://fixture.test/origin/comments?markerId=origin-comment&limit=6&replyLimit=1&namespace=default";
          const get = await within(worker.dispatchFetch(url));
          assert.equal(get.status, 200);
          assert.match(get.headers.get("cache-control"), /^public, max-age=\d+$/);
          assert.match(get.headers.get("cloudflare-cdn-cache-control"), /^public, max-age=\d+$/);
          assert.equal(get.headers.get("x-oem-marker-comment-kv-cache"), "enabled");
          assert.ok(get.headers.get("cache-tag"));
          const payload = await get.json();
          assert.equal(payload.items.length, 1);
          assert.equal(payload.items[0].content, "Content native-comment");
          assert.equal(payload.items[0].replies.length, 1);
          assert.equal(payload.items[0].replies[0].content, "Content native-reply");
          assert.equal(payload.items[0].replyCount, 2);

          const head = await within(worker.dispatchFetch(url, { method: "HEAD" }));
          assert.equal(head.status, 200);
          for (const header of [
            "cache-control",
            "cloudflare-cdn-cache-control",
            "cache-tag",
            "x-oem-marker-comment-kv-cache",
          ]) {
            assert.equal(head.headers.get(header), get.headers.get(header));
          }
          assert.equal(await head.text(), "");

          const empty = await within(
            worker.dispatchFetch(url.replace("origin-comment", "origin-empty-comment")),
          );
          assert.deepEqual(await empty.json(), { items: [] });
          assert.match(empty.headers.get("cache-control"), /^public, max-age=\d+$/);
          assert.match(empty.headers.get("cloudflare-cdn-cache-control"), /^public, max-age=\d+$/);
        },
      );
      await t.test(
        "origin validation rejects unsupported methods, resources and invalid selections without caching",
        async () => {
          const images =
            "/origin/images?markerId=origin-image&limit=6&namespace=prod&assetBaseUrl=https://assets.test";
          const comments =
            "/origin/comments?markerId=origin-comment&limit=6&replyLimit=1&namespace=prod";
          const cases = [
            [images, "POST", 405],
            ["/origin/unknown", "GET", 404],
            [images.replace("markerId=origin-image", "markerId=%20"), "GET", 422],
            [images.replace("limit=6", "limit=1.5"), "GET", 422],
            [images.replace("namespace=prod", "namespace=private"), "GET", 422],
            [images.replace("&assetBaseUrl=https://assets.test", ""), "GET", 422],
            [comments.replace("replyLimit=1", "replyLimit=-1"), "GET", 422],
            [comments.replace("limit=6&", ""), "GET", 422],
            ["/origin/progress-stats", "GET", 422],
            ["/origin/progress-stats?markerIndexHash=invalid", "GET", 422],
          ];
          const before = (await db.prepare("SELECT * FROM ugc_submissions ORDER BY id").all())
            .results;
          for (const [path, method, status] of cases) {
            const response = await within(
              worker.dispatchFetch(`https://fixture.test${path}`, { method }),
            );
            assert.equal(response.status, status, path);
            assert.equal(response.headers.get("cache-control"), "private, no-store", path);
            assert.equal(response.headers.get("cloudflare-cdn-cache-control"), null, path);
            assert.equal((await response.json()).code, "INVALID_PUBLIC_CACHE_REQUEST", path);
          }
          assert.deepEqual(
            (await db.prepare("SELECT * FROM ugc_submissions ORDER BY id").all()).results,
            before,
          );
        },
      );
      await t.test("subscribed sockets release both intervals immediately on abort", async () => {
        assert.deepEqual(await read("socket"), { active: 2, timers: 0 });
      });
      await t.test(
        "one-shot positions recover an HTTP outage through a native socket and release all timers",
        async () => {
          const game = await worker.getWorker("upstream");
          await game.fetch("https://game.test/test/mode", { method: "POST", body: "http-down" });
          try {
            assert.deepEqual(await read("position-fallback"), {
              position: {
                pos: { x: 1, y: 2, z: 3 },
                levelId: "level",
                isOnline: true,
                mapId: "map",
              },
              timers: 0,
            });
          } finally {
            await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
          }
        },
      );
      await t.test("one-shot positions close the upstream socket and all deadlines", async () => {
        assert.deepEqual(await read("position"), {
          position: { pos: { x: 1, y: 2, z: 3 }, levelId: "level", isOnline: true, mapId: "map" },
          timers: 0,
        });
      });
      await t.test(
        "one-shot fallback preserves the game's expired-login error over the earlier HTTP outage",
        async () => {
          const game = await worker.getWorker("upstream");
          await game.fetch("https://game.test/test/mode", {
            method: "POST",
            body: "fallback-expired",
          });
          try {
            const result = await read("position-fallback-attempt");
            assert.equal(result.error.status, 401);
            assert.equal(result.error.code, "ENDFIELD_CREDENTIAL_REJECTED");
            assert.equal(result.error.details.upstreamCode, 10002);
            assert.equal(result.timers, 0);
            await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
            const recovered = await read("position-fallback-attempt");
            assert.deepEqual(recovered.position.pos, { x: 9, y: 0, z: 8 });
            assert.equal(recovered.timers, 0);
          } finally {
            await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
          }
        },
      );
      for (const [mode, code, status] of [
        ["device-rejected", "ENDFIELD_DEVICE_REJECTED", 502],
        ["silent", "ENDFIELD_POSITION_SOCKET_TIMEOUT", 504],
      ]) {
        await t.test(
          `one-shot positions: ${mode} releases deadlines and a later request succeeds`,
          async () => {
            const game = await worker.getWorker("upstream");
            await game.fetch("https://game.test/test/mode", { method: "POST", body: mode });
            try {
              const failed = await read("position-attempt");
              assert.equal(failed.error.code, code);
              assert.equal(failed.error.status, status);
              assert.equal(failed.timers, 0);
              if (mode === "silent") {
                assert.equal(failed.error.details.authAckSeen, true);
                assert.equal(failed.error.details.subscriptionSent, true);
              }
              await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
              assert.deepEqual(await read("position-attempt"), {
                position: {
                  pos: { x: 1, y: 2, z: 3 },
                  levelId: "level",
                  isOnline: true,
                  mapId: "map",
                },
                timers: 0,
              });
            } finally {
              await game.fetch("https://game.test/test/mode", { method: "POST", body: "position" });
            }
          },
        );
      }
      await db
        .prepare(
          `INSERT INTO progress_stats_outbox
         (event_id, uid, mutation_id, marker_index_hash, payload, next_attempt_at, created_at)
         VALUES ('event', 'user', 'mutation', 'hash', ?1, 0, 0)`,
        )
        .bind(
          JSON.stringify({
            eventId: "event",
            markerIndexHash: "hash",
            pointCount: 1,
            increments: [0],
            decrements: [],
            firstSync: true,
          }),
        )
        .run();
      await t.test("outbox acknowledgements clear the ten-second deadline", async () => {
        assert.deepEqual(await read("outbox"), { delivered: true, timers: 0 });
      });
      for (const mode of ["success", "stale", "rollback"]) {
        await t.test(`native D1 credential/profile transaction: ${mode}`, async () => {
          await db.prepare("DELETE FROM endfield_bindings").run();
          await db.prepare("DELETE FROM endfield_role_device_profiles").run();
          await db
            .prepare(
              "INSERT INTO endfield_bindings (uid, provider, role_id, server_id, cred_enc, token_enc, status, updated_at) VALUES ('user', 'skland', 'role', 1, 'cred', 'token', 'enabled', 'old')",
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
