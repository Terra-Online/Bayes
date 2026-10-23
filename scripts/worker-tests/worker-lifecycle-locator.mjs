import assert from "node:assert/strict";

import { deferred, within } from "./worker-test-runtime.mjs";

export async function testLocator(t, { worker, db, read, connect: openConnection, authHeaders }) {
  const game = await worker.getWorker("upstream");
  const sockets = [];
  const setGameMode = (mode) =>
    game.fetch("https://game.test/test/mode", { method: "POST", body: mode });
  const connect = async (path, headers) => {
    const connection = await openConnection(path, headers);
    sockets.push(connection.socket);
    return connection;
  };
  // Failed assertions must not leave a browser connected or a fault active for the next scenario.
  t.afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      if (socket.readyState === 1) {
        socket.close(1000);
      }
    }
    await setGameMode("position");
    await db.prepare("DELETE FROM endfield_bindings").run();
    await db.prepare("DELETE FROM endfield_role_device_profiles").run();
  });
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
      sockets.push(socket);
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
      const unauthorized = await worker.dispatchFetch("https://fixture.test/locator/position");
      assert.equal(unauthorized.status, 401);
      // Ordinary browser messages are ignored; the close command remains usable.
      socket.send("not a locator command");
      socket.send("close");
      const ended = await within(closed.promise);
      assert.equal(ended.code, 1000);
      assert.equal(ended.reason, "closed");
      assert.deepEqual(await read("timers"), { timers: 0 });
    },
  );

  await t.test(
    "locator: a rejected stream refreshes saved credentials and reconnects without dropping the browser",
    async () => {
      await setGameMode("refresh");
      await read("seed-binding");
      const before = await db.prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'").first();
      const stream = await connect("locator/position-stream", authHeaders);
      const frames = [];

      for (let count = 0; count < 8; count++) {
        const frame = JSON.parse(await stream.next());
        frames.push(frame);
        if (frame.type === "position") {
          break;
        }
      }
      assert.ok(
        frames.some(
          (frame) => frame.status === "reconnecting" && frame.reason === "refreshing credentials",
        ),
      );
      assert.equal(frames.filter((frame) => frame.status === "connected").length, 2);
      assert.deepEqual(frames.at(-1), {
        type: "position",
        data: { pos: { x: 1, y: 2, z: 3 }, levelId: "level", isOnline: true, mapId: "map" },
      });
      const after = await db.prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'").first();
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
    },
  );
  await t.test(
    "locator: an expired game login reports rebinding without replacing saved credentials",
    async () => {
      await setGameMode("expired");
      await read("seed-binding");
      const before = await db.prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'").first();
      const stream = await connect("locator/position-stream", authHeaders);

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
    },
  );
  await t.test(
    "locator: rejected upgrade preserves the binding when refresh fails and a new browser connection recovers",
    async () => {
      await setGameMode("upgrade-rejected");
      await read("seed-binding");
      const before = await db.prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'").first();
      const first = await connect("locator/position-stream", authHeaders);

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
      const retry = await connect("locator/position-stream", authHeaders);
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
    },
  );
  for (const [mode, status, code] of [
    ["token-down", 502, "ENDFIELD_UPSTREAM_REJECTED"],
    ["transport-error", 500, "LOCATOR_STREAM_ERROR"],
  ]) {
    await t.test(
      `locator: ${mode} reports an error then reconnects with the same binding`,
      async () => {
        await setGameMode(mode);
        await read("seed-binding");
        const before = await db
          .prepare("SELECT * FROM endfield_bindings WHERE uid = 'user'")
          .first();
        const stream = await connect("locator/position-stream", authHeaders);
        const frames = [];

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
      },
    );
  }

  await t.test("subscribed sockets release both intervals immediately on abort", async () => {
    assert.deepEqual(await read("socket"), { active: 2, timers: 0 });
  });
  await t.test(
    "one-shot positions recover an HTTP outage through a native socket and release all timers",
    async () => {
      await setGameMode("http-down");

      assert.deepEqual(await read("position-fallback"), {
        position: {
          pos: { x: 1, y: 2, z: 3 },
          levelId: "level",
          isOnline: true,
          mapId: "map",
        },
        timers: 0,
      });
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
      await setGameMode("fallback-expired");

      const result = await read("position-fallback-attempt");
      assert.equal(result.error.status, 401);
      assert.equal(result.error.code, "ENDFIELD_CREDENTIAL_REJECTED");
      assert.equal(result.error.details.upstreamCode, 10002);
      assert.equal(result.timers, 0);
      await setGameMode("position");
      const recovered = await read("position-fallback-attempt");
      assert.deepEqual(recovered.position.pos, { x: 9, y: 0, z: 8 });
      assert.equal(recovered.timers, 0);
    },
  );
  for (const [mode, code, status] of [
    ["device-rejected", "ENDFIELD_DEVICE_REJECTED", 502],
    ["silent", "ENDFIELD_POSITION_SOCKET_TIMEOUT", 504],
  ]) {
    await t.test(
      `one-shot positions: ${mode} releases deadlines and a later request succeeds`,
      async () => {
        await setGameMode(mode);

        const failed = await read("position-attempt");
        assert.equal(failed.error.code, code);
        assert.equal(failed.error.status, status);
        assert.equal(failed.timers, 0);
        if (mode === "silent") {
          assert.equal(failed.error.details.authAckSeen, true);
          assert.equal(failed.error.details.subscriptionSent, true);
        }
        await setGameMode("position");
        assert.deepEqual(await read("position-attempt"), {
          position: {
            pos: { x: 1, y: 2, z: 3 },
            levelId: "level",
            isOnline: true,
            mapId: "map",
          },
          timers: 0,
        });
      },
    );
  }
}
