import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

import { unstable_splitSqlQuery } from "wrangler";

import { migrateNativeDatabase } from "./native-test-database.mjs";
import { Miniflare } from "./worker-test-runtime.mjs";

// Use the installed runtime's compiler so this test also runs on Node 22,
// where loading TypeScript directly is not enabled by default.
const runtimeRequire = createRequire(
  createRequire(import.meta.url).resolve("wrangler/package.json"),
);
const { transform } = runtimeRequire("esbuild");
const imageCommandSource = await readFile(
  new URL("../../src/repositories/submission/createImage.ts", import.meta.url),
  "utf8",
);
const imageCommand = await transform(imageCommandSource, {
  loader: "ts",
  format: "esm",
  target: "es2022",
});
const { createPendingImage, markImageModerationQueued } = await import(
  `data:text/javascript;base64,${Buffer.from(imageCommand.code).toString("base64")}`
);

const candidate = await readFile(
  new URL("../../migrations/0038_ugc_snapshots.sql", import.meta.url),
  "utf8",
);
const seed = await readFile(
  new URL("../../src/test/fixtures/ugcSnapshotLegacy.sql", import.meta.url),
  "utf8",
);
const retained = [
  "ugc_submission_upvotes",
  "ugc_submission_votes",
  "ugc_submission_flags",
  "notifications",
  "notification_messages",
  "notification_counters",
];

async function rows(db, tables) {
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
      ]),
    ),
  );
}

// One batch is the transaction. Separate prepare().run() calls cannot supply
// atomic DDL replacement and must never be used to execute this candidate.
function batch(db, source) {
  return db.batch(unstable_splitSqlQuery(source).map((sql) => db.prepare(sql)));
}

async function legacyState(db) {
  return {
    schema: (await db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all()).results,
    data: await rows(db, ["ugc_submissions", ...retained]),
  };
}

async function withDatabase(run) {
  const worker = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("isolated migration test"); } }',
    compatibilityDate: "2026-07-22",
    d1Databases: { DB: "ugc-snapshot-import-test" },
    outboundService() {
      throw new Error("External network prohibited");
    },
  });
  try {
    const db = await worker.getD1Database("DB");
    await migrateNativeDatabase(db, { before: "0038" });
    await batch(db, seed);
    await run(db);
  } finally {
    await worker.dispose();
  }
}

test("local D1 commits the import, preserving every dependent row and unread counter", async () => {
  await withDatabase(async (db) => {
    const before = await rows(db, retained);
    await batch(db, candidate);
    assert.deepEqual(await rows(db, retained), before);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM ugc_snapshots").first()).n, 10);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM ugc_snapshots_review_audit").first()).n,
      0,
    );
    assert.deepEqual(
      await db
        .prepare(
          "SELECT id,creator_user_id,created_at FROM ugc_snapshots WHERE id='snap-comment-active'",
        )
        .first(),
      {
        id: "snap-comment-active",
        creator_user_id: "owner",
        created_at: "2025-01-01",
      },
    );
    await db.prepare("UPDATE notifications SET read_at='read' WHERE id='unread'").run();
    assert.equal(
      (
        await db
          .prepare("SELECT community_unread FROM notification_counters WHERE user_id='owner'")
          .first()
      ).community_unread,
      0,
    );
    await db.prepare("UPDATE notifications SET read_at=NULL WHERE id='unread'").run();
    assert.equal(
      (
        await db
          .prepare("SELECT community_unread FROM notification_counters WHERE user_id='owner'")
          .first()
      ).community_unread,
      1,
    );
  });
});

for (const status of ["pending_openai", "pending_audit"]) {
  test(`local D1 rejects ${status} comments and restores the complete legacy state`, async () => {
    await withDatabase(async (db) => {
      await db
        .prepare("UPDATE ugc_submissions SET status=? WHERE id='comment-active'")
        .bind(status)
        .run();
      const before = await legacyState(db);
      await assert.rejects(batch(db, candidate), /CHECK constraint/);
      assert.deepEqual(await legacyState(db), before);
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
  });
}

test("local D1 restores detached dependencies when failure happens at the end of migration", async () => {
  await withDatabase(async (db) => {
    const before = await legacyState(db);
    await assert.rejects(
      batch(db, candidate + "\nINSERT INTO ugc_snapshots(id) VALUES ('invalid');"),
      /NOT NULL/,
    );
    assert.deepEqual(await legacyState(db), before);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  });
});

test("local D1 failed append retains the frontier and next successful append uses revision two", async () => {
  await withDatabase(async (db) => {
    await batch(db, candidate);
    const append = (content) =>
      db.batch([
        db.prepare("UPDATE ugc_submissions SET revision=revision+1 WHERE id='comment-active'"),
        db
          .prepare(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,content,review_status,creator_user_id)
        SELECT 'second',id,kind,revision,?,'pending_openai',user_id FROM ugc_submissions WHERE id='comment-active'`)
          .bind(content),
      ]);
    await assert.rejects(append("   "), /CHECK constraint/);
    assert.equal(
      (await db.prepare("SELECT revision FROM ugc_submissions WHERE id='comment-active'").first())
        .revision,
      1,
    );
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM ugc_snapshots WHERE id='second'").first()).n,
      0,
    );
    await append("Second body");
    assert.deepEqual(
      (
        await db
          .prepare(
            "SELECT revision FROM ugc_snapshots WHERE submission_id='comment-active' ORDER BY revision",
          )
          .all()
      ).results,
      [{ revision: 1 }, { revision: 2 }],
    );
    await assert.rejects(
      db.prepare("UPDATE ugc_snapshots SET content='overwrite' WHERE id='second'").run(),
      /immutable/,
    );
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  });
});

test("local D1 image creation rolls back identity on snapshot failure and binds delivery to the exact version", async () => {
  await withDatabase(async (db) => {
    await batch(db, candidate);
    const image = {
      id: "new-image",
      snapshotId: "new-image-snapshot",
      userId: "owner",
      markerId: "marker",
      poiHash: "hash",
      poiType: "poi",
      filePath: "images/new.webp",
      mimeType: "image/webp",
      sizeBytes: 3,
    };
    await createPendingImage(db, image);
    await assert.rejects(
      createPendingImage(db, { ...image, id: "rolled-back" }),
      /UNIQUE constraint/,
    );
    assert.equal(
      await db.prepare("SELECT id FROM ugc_submissions WHERE id='rolled-back'").first(),
      null,
    );
    assert.deepEqual(
      await db.prepare("SELECT revision FROM ugc_submissions WHERE id='new-image'").first(),
      { revision: 1 },
    );
    await markImageModerationQueued(db, {
      submissionId: "wrong-image",
      snapshotId: image.snapshotId,
      queuedAt: "wrong",
    });
    assert.deepEqual(
      await db
        .prepare("SELECT moderation_queued_at FROM ugc_snapshots WHERE id='new-image-snapshot'")
        .first(),
      { moderation_queued_at: null },
    );
    await markImageModerationQueued(db, {
      submissionId: image.id,
      snapshotId: image.snapshotId,
      queuedAt: "delivered",
    });
    assert.deepEqual(
      await db
        .prepare(
          "SELECT file_path, moderation_queued_at FROM ugc_snapshots WHERE id='new-image-snapshot'",
        )
        .first(),
      { file_path: image.filePath, moderation_queued_at: "delivered" },
    );
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  });
});
