import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const { buildDemoImageSql } = await import(new URL("../demo-ugc-database.mjs", import.meta.url));

test("demo sync preserves immutable history and identity, appends changes, and rolls back failures", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const directory = new URL("../../migrations/", import.meta.url);
    for (const name of readdirSync(directory).sort()) {
      const source = readFileSync(new URL(name, directory), "utf8");
      db.exec(name.startsWith("0038") ? `BEGIN;\n${source}\nCOMMIT;` : source);
    }
    db.exec(
      "INSERT INTO users(uid,email,password_hash,nickname) VALUES ('demo','demo@example.test','','Demo')",
    );
    const image = {
      id: "photo",
      markerId: "point",
      url: "https://assets.test/demo/photo.webp",
      content: "First caption",
      localSize: 3,
      createdAt: "2026-01-01",
    };
    const sync = (input) => {
      db.exec("BEGIN");
      try {
        db.exec(buildDemoImageSql(input, "demo"));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    const state = () => ({
      submissions: db.prepare("SELECT * FROM ugc_submissions").all(),
      snapshots: db.prepare("SELECT * FROM ugc_snapshots ORDER BY revision").all(),
    });
    sync(image);
    const first = state();
    sync(image);
    assert.deepEqual(state(), first);
    sync({ ...image, content: "Second caption", createdAt: "2026-02-01" });
    assert.deepEqual(state().snapshots[0], first.snapshots[0]);
    assert.deepEqual(
      state().snapshots.map(({ revision, content }) => ({ revision, content })),
      [
        { revision: 1, content: "First caption" },
        { revision: 2, content: "Second caption" },
      ],
    );
    assert.equal(state().submissions[0].created_at, "2026-01-01");
    assert.equal(state().submissions[0].user_id, "demo");
    assert.equal(state().submissions[0].revision, 2);
    const beforeFailure = state();
    db.exec(
      "CREATE TRIGGER fail_sync BEFORE INSERT ON ugc_snapshots BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    assert.throws(() => sync({ ...image, id: "failed" }), /injected failure/);
    assert.deepEqual(state(), beforeFailure);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
