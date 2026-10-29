import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  stdin: {
    contents:
      'export * from "./src/repositories/submission/deleteByAuthor.ts"; export * from "./src/repositories/submission/reviewSnapshot.ts";',
    resolveDir: new URL("../..", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022",
});
const { deleteByAuthor, getReviewTarget, reviewSnapshot } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const candidate = await readFile(
  new URL("../../migration-candidates/ugc-snapshots/import-current.sql", import.meta.url),
  "utf8",
);
const batchSql = (db, sql) =>
  db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));
async function withDatabase(kind, run) {
  const worker = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("author delete test")}}',
    compatibilityDate: "2026-07-22",
    d1Databases: { DB: "author-delete" },
    outboundService() {
      throw new Error("External network prohibited");
    },
  });
  try {
    const db = await worker.getD1Database("DB");
    await migrateNativeDatabase(db);
    await batchSql(db, candidate);
    await batchSql(
      db,
      `INSERT INTO users(uid,email,password_hash,nickname,role,uid_number,uid_suffix)
 VALUES ('author','author@example.test','unused','Author','n',100001,'AA'),('other','other@example.test','unused','Other','a',100002,'AA');
 INSERT INTO ugc_submissions(id,kind,poi_id,poi_hash,poi_type,user_id) VALUES ('target','${kind}','point','hash','poi','author');
 INSERT INTO ugc_snapshots(id,submission_id,kind,revision,content,file_path,review_status,creator_user_id)
 VALUES ('A','target','${kind}',1,'Content','image.webp','pending_openai','author');
 INSERT INTO ugc_submission_flags(submission_id,user_id,active) VALUES ('target','other',1);`,
    );
    const command = { submissionId: "target", kind, authorId: "author" };
    const review = {
      target: await getReviewTarget(db, "target", "A"),
      expectedReviewStatus: "pending_openai",
      source: "ai",
      decision: "approved",
      auditId: "receipt",
    };
    await run(db, command, review);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await worker.dispose();
  }
}
for (const kind of ["comment", "image"]) {
  test(`native D1 ${kind} deletion first suppresses a selected review and preserves independent disable/flags`, async () =>
    withDatabase(kind, async (db, command, review) => {
      assert.deepEqual(await deleteByAuthor(db, { ...command, authorId: "other" }), {
        outcome: "unauthorized",
      });
      const first = await deleteByAuthor(db, command);
      assert.equal(first.outcome, "deleted");
      assert.deepEqual(await deleteByAuthor(db, command), { ...first, outcome: "already_deleted" });
      assert.deepEqual(await reviewSnapshot(db, review), { outcome: "ignored" });
      await db
        .prepare("UPDATE ugc_submissions SET admin_deleted_at='disabled',admin_deleted_by='other'")
        .run();
      assert.equal(
        (await db.prepare("SELECT count(*) n FROM ugc_snapshots_review_audit").first()).n,
        0,
      );
      assert.equal((await db.prepare("SELECT count(*) n FROM notifications").first()).n, 0);
      assert.equal((await db.prepare("SELECT active FROM ugc_submission_flags").first()).active, 1);
      assert.deepEqual(
        await db
          .prepare("SELECT admin_deleted_at,admin_deleted_by,revision FROM ugc_submissions")
          .first(),
        { admin_deleted_at: "disabled", admin_deleted_by: "other", revision: 1 },
      );
    }));
  test(`native D1 ${kind} review first retains approval effects after concurrent deletion and retries`, async () =>
    withDatabase(kind, async (db, command, review) => {
      assert.equal((await reviewSnapshot(db, review)).outcome, "committed");
      const messages = (await db.prepare("SELECT * FROM notification_messages").all()).results;
      const deleted = await Promise.all([deleteByAuthor(db, command), deleteByAuthor(db, command)]);
      assert.deepEqual(deleted.map((r) => r.outcome).sort(), ["already_deleted", "deleted"]);
      assert.equal(deleted[0].authorDeletedAt, deleted[1].authorDeletedAt);
      assert.deepEqual(
        (await db.prepare("SELECT * FROM notification_messages").all()).results,
        messages,
      );
      assert.equal(
        (await db.prepare("SELECT count(*) n FROM ugc_public_submissions").first()).n,
        0,
      );
      assert.equal(
        (await db.prepare("SELECT review_status FROM ugc_snapshots").first()).review_status,
        "approved",
      );
    }));
  test(`native D1 ${kind} failed deletion rolls back and a retry needs no snapshot`, async () =>
    withDatabase(kind, async (db, command) => {
      await batchSql(
        db,
        `CREATE TRIGGER fail_delete BEFORE UPDATE OF author_deleted_at ON ugc_submissions BEGIN SELECT RAISE(ABORT,'delete failed'); END;`,
      );
      await assert.rejects(deleteByAuthor(db, command), /delete failed/);
      assert.equal(
        (await db.prepare("SELECT author_deleted_at FROM ugc_submissions").first())
          .author_deleted_at,
        null,
      );
      await db.prepare("DROP TRIGGER fail_delete").run();
      await db
        .prepare(
          "INSERT INTO ugc_submissions(id,kind,poi_id,poi_hash,poi_type,user_id) VALUES ('no-snapshot',?,'point','hash','poi','author')",
        )
        .bind(kind)
        .run();
      assert.equal(
        (await deleteByAuthor(db, { ...command, submissionId: "no-snapshot" })).outcome,
        "deleted",
      );
      assert.equal((await deleteByAuthor(db, command)).outcome, "deleted");
    }));
}
