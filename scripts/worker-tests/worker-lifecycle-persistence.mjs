import assert from "node:assert/strict";

export async function testPersistence(t, { db, read }) {
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
}
