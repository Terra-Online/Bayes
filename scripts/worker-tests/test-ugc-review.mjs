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
    contents: `export * from "./reviewSnapshot.ts";
      export { setSubmissionReport } from "./flagSubmission.ts";
      export { setImageUpvote } from "./voteSubmission.ts";`,
    resolveDir: new URL("../../src/repositories/submission/", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022",
});
const { getReviewTarget, reviewSnapshot, setSubmissionReport, setImageUpvote } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const candidate = await readFile(
  new URL("../../migration-candidates/ugc-snapshots/import-current.sql", import.meta.url),
  "utf8",
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
    await batchSql(db, candidate);
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
    const target = await getReviewTarget(db, "comment", "B");
    const command = {
      target,
      expectedReviewStatus: "pending_openai",
      decision: "approved",
      source: "ai",
      auditId: "receipt-1",
    };
    await run(db, command);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await worker.dispose();
  }
}

async function state(db) {
  const results = await db.batch([
    db.prepare("SELECT id,review_status FROM ugc_snapshots ORDER BY revision"),
    db.prepare("SELECT id FROM ugc_snapshots_review_audit"),
    db.prepare("SELECT active FROM ugc_submission_flags"),
    db.prepare("SELECT type,message_count FROM notifications"),
    db.prepare("SELECT dedupe_key FROM notification_messages"),
    db.prepare("SELECT * FROM notification_counters"),
  ]);
  return results.map((result) => result.results);
}

test("native D1 atomically approves B, clears A reports, and ignores a duplicate without clearing fresh B reports", async () => {
  await withDatabase(async (db, command) => {
    const result = await reviewSnapshot(db, command);
    assert.equal(result.outcome, "committed");
    assert.equal(result.firstApproval, false);
    assert.equal(result.publicReplaced, true);
    assert.equal(result.notifications.length, 1);
    assert.equal(
      (await db.prepare("SELECT snapshot_id FROM ugc_public_submissions").first()).snapshot_id,
      "B",
    );
    assert.equal((await db.prepare("SELECT active FROM ugc_submission_flags").first()).active, 0);
    await db.prepare("UPDATE ugc_submission_flags SET active=1").run();
    const before = await state(db);
    assert.deepEqual(await reviewSnapshot(db, { ...command, auditId: "receipt-2" }), {
      outcome: "ignored",
    });
    assert.deepEqual(await state(db), before);
  });
});

test("native D1 notification failure rolls back review, audit, flags and unread aggregation", async () => {
  await withDatabase(async (db, command) => {
    await batchSql(
      db,
      `CREATE TRIGGER fail_notification BEFORE INSERT ON notification_messages
      BEGIN SELECT RAISE(ABORT,'notification failed'); END;`,
    );
    const before = await state(db);
    await assert.rejects(reviewSnapshot(db, command), /notification failed/);
    assert.deepEqual(await state(db), before);
    await db.prepare("DROP TRIGGER fail_notification").run();
    assert.equal((await reviewSnapshot(db, { ...command, auditId: "retry" })).outcome, "committed");
  });
});

test("native D1 rejects receipt collisions even when the target phase is stale", async () => {
  await withDatabase(async (db, command) => {
    await reviewSnapshot(db, command);
    const before = await state(db);
    await assert.rejects(reviewSnapshot(db, command), /UNIQUE constraint/);
    assert.deepEqual(await state(db), before);
  });
});

test("native D1 admin takeover defeats in-flight AI and deletion defeats a later admin review", async () => {
  await withDatabase(async (db, command) => {
    const takeover = {
      ...command,
      source: "admin",
      adminUserId: "admin",
      decision: "pending_audit",
    };
    assert.equal((await reviewSnapshot(db, takeover)).outcome, "committed");
    assert.deepEqual(await reviewSnapshot(db, { ...command, auditId: "late-ai" }), {
      outcome: "ignored",
    });
    await db
      .prepare("UPDATE ugc_submissions SET author_deleted_at='deleted' WHERE id='comment'")
      .run();
    const before = await state(db);
    assert.deepEqual(
      await reviewSnapshot(db, {
        ...takeover,
        auditId: "late-admin",
        expectedReviewStatus: "pending_audit",
        decision: "approved",
      }),
      { outcome: "ignored" },
    );
    assert.deepEqual(await state(db), before);
  });
});

const actor = {
  uid: "admin",
  publicUid: "100002AA",
  nickname: "Admin",
  avatar: 1,
  email: "admin@example.test",
  role: "a",
  karma: 0,
  needsProfileSetup: false,
};
const report = (db, active, snapshotId = "A") =>
  setSubmissionReport(db, {
    submissionId: "comment",
    kind: "comment",
    userId: "admin",
    snapshotId,
    active,
  });

test("native D1 serializes both report directions against a real public replacement", async () => {
  for (const active of [true, false]) {
    await withDatabase(async (db, command) => {
      if (active) {
        await report(db, false);
      }
      const [reported, reviewed] = await Promise.all([
        report(db, active),
        reviewSnapshot(db, command),
      ]);
      assert.equal(reviewed.outcome, "committed");
      assert.ok(["committed", "conflict"].includes(reported.outcome));
      assert.equal((await db.prepare("SELECT active FROM ugc_submission_flags").first()).active, 0);
      assert.deepEqual(await report(db, active), { outcome: "conflict" });
      assert.equal((await report(db, true, "B")).changed, true);
      assert.deepEqual(await reviewSnapshot(db, { ...command, auditId: "duplicate" }), {
        outcome: "ignored",
      });
      assert.equal((await db.prepare("SELECT active FROM ugc_submission_flags").first()).active, 1);
    });
  }
});

test("native D1 report no-ops retain classification and hide preserves reports", async () => {
  await withDatabase(async (db) => {
    const duplicate = await report(db, true);
    assert.equal(duplicate.outcome, "committed");
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.flagCount, 1);
    await db.prepare("UPDATE ugc_submissions SET author_deleted_at='gone'").run();
    assert.deepEqual(await report(db, false), { outcome: "conflict" });
    assert.deepEqual(await report(db, true), { outcome: "conflict" });
    assert.equal((await db.prepare("SELECT active FROM ugc_submission_flags").first()).active, 1);
  });
});

async function addImage(db) {
  await batchSql(
    db,
    `INSERT INTO ugc_submissions(id,kind,poi_id,poi_hash,poi_type,user_id)
    VALUES ('image','image','point','hash','item','author');
    INSERT INTO ugc_snapshots(id,submission_id,kind,revision,file_path,review_status,creator_user_id)
    VALUES ('image-A','image','image',1,'images/A.webp','approved','author');`,
  );
}

test("native D1 serializes like and unlike against deletion without late notifications or cancellations", async () => {
  for (const active of [true, false]) {
    await withDatabase(async (db) => {
      await addImage(db);
      if (!active) {
        await setImageUpvote(db, { submissionId: "image", actor, active: true });
      }
      const [result] = await Promise.all([
        setImageUpvote(db, { submissionId: "image", actor, active }),
        db.prepare("UPDATE ugc_submissions SET author_deleted_at='gone' WHERE id='image'").run(),
      ]);
      assert.ok(["committed", "hidden"].includes(result.outcome));
      const before = await db.prepare("SELECT * FROM ugc_submission_upvotes").all();
      const notifications = await db.prepare("SELECT * FROM notification_messages").all();
      assert.deepEqual(await setImageUpvote(db, { submissionId: "image", actor, active }), {
        outcome: "hidden",
      });
      assert.deepEqual(
        (await db.prepare("SELECT * FROM ugc_submission_upvotes").all()).results,
        before.results,
      );
      assert.deepEqual(
        (await db.prepare("SELECT * FROM notification_messages").all()).results,
        notifications.results,
      );
      if (active && result.outcome === "hidden") {
        assert.equal(notifications.results.length, 0);
      }
      if (active && result.outcome === "committed") {
        assert.equal(notifications.results.length, 1);
      }
      if (!active) {
        assert.equal(notifications.results.length, 1);
      }
    });
  }
});

test("native D1 rolls back image aggregation when the vote fails and notification failure rolls back the vote", async () => {
  await withDatabase(async (db) => {
    await addImage(db);
    for (const table of ["ugc_submission_upvotes", "notification_messages"]) {
      await db
        .prepare(`CREATE TRIGGER fail_like BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT,'like unavailable'); END`)
        .run();
      await assert.rejects(
        setImageUpvote(db, { submissionId: "image", actor, active: true }),
        /like unavailable/,
      );
      for (const name of [
        "ugc_submission_upvotes",
        "notifications",
        "notification_messages",
        "notification_counters",
      ]) {
        assert.deepEqual((await db.prepare(`SELECT * FROM ${name}`).all()).results, []);
      }
      await db.prepare("DROP TRIGGER fail_like").run();
    }
    const first = await setImageUpvote(db, { submissionId: "image", actor, active: true });
    assert.equal(first.changed, true);
    const duplicate = await setImageUpvote(db, { submissionId: "image", actor, active: true });
    assert.equal(duplicate.changed, false);
    assert.deepEqual(duplicate.notifications, []);
    assert.equal(
      (await db.prepare("SELECT message_count FROM notifications").first()).message_count,
      1,
    );
  });
});
