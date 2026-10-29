import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { unstable_splitSqlQuery } from "wrangler";

import { migrateNativeDatabase } from "./native-test-database.mjs";
import { Miniflare } from "./worker-test-runtime.mjs";

const requireRuntime = createRequire(
  createRequire(import.meta.url).resolve("wrangler/package.json"),
);
const { build } = requireRuntime("esbuild");
const compiled = await build({
  entryPoints: [
    new URL("../../src/repositories/submission/managementActions.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022",
});
const { disableSubmission, clearSubmissionFlags } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const batchSql = (db, sql) =>
  db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));

async function withDatabase(run) {
  const worker = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("review transaction test")}}',
    compatibilityDate: "2026-07-22",
    d1Databases: { DB: "ugc-review-test" },
    outboundService() {
      throw new Error("External network prohibited");
    },
  });
  try {
    const db = await worker.getD1Database("DB");
    await migrateNativeDatabase(db);

    await batchSql(
      db,
      `
      INSERT INTO users(uid,email,password_hash,nickname,role,uid_number,uid_suffix)
      VALUES ('author','author@example.test','unused','Author','n',100001,'AA'),
        ('admin','admin@example.test','unused','Admin','a',100002,'AA');
      INSERT INTO ugc_submissions(id,kind,poi_id,poi_hash,poi_type,user_id)
      VALUES ('comment','comment','point','hash','item','author');
      INSERT INTO ugc_snapshots(id,submission_id,kind,revision,content,review_status,creator_user_id)
      VALUES ('A','comment','comment',1,'Original','approved','author');
      INSERT INTO ugc_snapshots(id,submission_id,kind,revision,content,review_status,creator_user_id)
      VALUES ('B','comment','comment',2,'Correction','pending_openai','author');
      UPDATE ugc_submissions SET revision=2 WHERE id='comment';
      INSERT INTO ugc_submission_flags(submission_id,user_id,active) VALUES ('comment','admin',1);
    `,
    );
    const command = { submissionId: "comment", snapshotId: "B", adminUserId: "admin" };
    await run(db, command);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await worker.dispose();
  }
}

test("native D1 overlapping disables commit only once, preserve first facts and keep review/reports", async () => {
  await withDatabase(async (db, command) => {
    const result = await Promise.all([
      disableSubmission(db, command),
      disableSubmission(db, command),
    ]);
    assert.deepEqual(result.map((row) => row.outcome).sort(), ["committed", "no_op"]);
    assert.equal(
      (await db.prepare("SELECT admin_deleted_by FROM ugc_submissions").first()).admin_deleted_by,
      "admin",
    );
    assert.equal(
      (await db.prepare("SELECT review_status FROM ugc_snapshots WHERE id='B'").first())
        .review_status,
      "pending_openai",
    );
    assert.equal((await db.prepare("SELECT active FROM ugc_submission_flags").first()).active, 1);
    assert.deepEqual(
      (await db.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).results,
      [],
    );
    assert.equal(
      (await disableSubmission(db, { ...command, snapshotId: "A" })).outcome,
      "conflict",
    );
  });
});
test("native D1 clear binds public A then hidden frontier B, checks roles, and classifies repeats", async () => {
  await withDatabase(async (db, command) => {
    assert.equal((await clearSubmissionFlags(db, command)).outcome, "conflict");
    assert.equal(
      (await clearSubmissionFlags(db, { ...command, snapshotId: "A", adminUserId: "author" }))
        .outcome,
      "conflict",
    );
    assert.equal(
      (await clearSubmissionFlags(db, { ...command, snapshotId: "A" })).outcome,
      "committed",
    );
    await db.prepare("UPDATE ugc_submission_flags SET active=1").run();
    await disableSubmission(db, command);
    assert.equal(
      (await clearSubmissionFlags(db, { ...command, snapshotId: "A" })).outcome,
      "conflict",
    );
    const cleared = await Promise.all([
      clearSubmissionFlags(db, command),
      clearSubmissionFlags(db, command),
    ]);
    assert.deepEqual(cleared.map((row) => row.outcome).sort(), ["committed", "no_op"]);
    assert.deepEqual((await db.prepare("SELECT * FROM ugc_public_submissions").all()).results, []);
    assert.deepEqual((await db.prepare("SELECT * FROM notifications").all()).results, []);
    assert.deepEqual(
      (await db.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).results,
      [],
    );
  });
});
test("native D1 trigger failure rolls back disable and the first actor fact", async () => {
  await withDatabase(async (db, command) => {
    await batchSql(
      db,
      "CREATE TRIGGER fail_disable AFTER UPDATE OF admin_deleted_at ON ugc_submissions BEGIN SELECT RAISE(ABORT,'disable failed'); END;",
    );
    await assert.rejects(disableSubmission(db, command), /disable failed/);
    assert.deepEqual(
      await db.prepare("SELECT admin_deleted_at,admin_deleted_by FROM ugc_submissions").first(),
      { admin_deleted_at: null, admin_deleted_by: null },
    );
    await db.prepare("DROP TRIGGER fail_disable").run();
    assert.equal((await disableSubmission(db, command)).outcome, "committed");
  });
});
