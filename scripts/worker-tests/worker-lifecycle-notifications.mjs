import assert from "node:assert/strict";

export async function testNotifications(t, { db, read, connect, authHeaders }) {
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
        assert.equal(JSON.parse(await neighbor.next()).notification.id, "neighbor-notification");
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
}
