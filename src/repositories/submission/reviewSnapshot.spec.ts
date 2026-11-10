import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertUser } from "@/test/fixtures/users";

import { getReviewTarget, reviewSnapshot, type ReviewCommand } from "./reviewSnapshot";

let database: TestDatabase;
let command: ReviewCommand;
beforeEach(async () => {
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "author" });
  insertUser(database.sqlite, { uid: "admin", role: "p" });
  insertCommentSnapshot(database.sqlite, {
    id: "comment",
    userId: "author",
    reviewStatus: "pending_openai",
  });
  command = {
    target: (await getReviewTarget(database.db, "comment"))!,
    expectedReviewStatus: "pending_openai",
    decision: "approved",
    source: "ai",
    auditId: "receipt",
  };
});
afterEach(() => database.close());

// Each mutation represents a commit after selection, before this serialized batch.
// These are write guards, not another review-policy acceptance matrix.
it.each([
  ["phase", "UPDATE ugc_snapshots SET review_status='pending_audit'"],
  ["author deletion", "UPDATE ugc_submissions SET author_deleted_at='gone'"],
  ["admin disable", "UPDATE ugc_submissions SET admin_deleted_at='gone',admin_deleted_by='admin'"],
  [
    "frontier",
    `UPDATE ugc_snapshots SET review_status='approved';
    INSERT INTO ugc_snapshots (id,submission_id,kind,revision,content,review_status,creator_user_id)
    VALUES ('B','comment','comment',2,'New version','pending_openai','author');
    UPDATE ugc_submissions SET revision=2`,
  ],
])(
  "ignores a selected target after its %s changes, with no audit or notification writes",
  async (_guard, sql) => {
    database.sqlite.exec(sql);
    const before = database.sqlite.prepare("SELECT * FROM ugc_snapshots").all();
    expect(await reviewSnapshot(database.db, command)).toEqual({ outcome: "ignored" });
    expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots").all()).toEqual(before);
    expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual([]);
    expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
  },
);

it("rechecks reviewer authority at commit", async () => {
  database.sqlite.exec("UPDATE users SET role='n' WHERE uid='admin'");
  expect(
    await reviewSnapshot(database.db, { ...command, source: "admin", adminUserId: "admin" }),
  ).toEqual({ outcome: "ignored" });
  expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual([]);
});

it("allows one receipt and leaves expired notification groups unchanged for a losing review", async () => {
  expect(await reviewSnapshot(database.db, command)).toMatchObject({ outcome: "committed" });
  database.sqlite.exec("UPDATE notifications SET window_expires_at='2000-01-01'");
  const before = database.sqlite.prepare("SELECT * FROM notifications").all();
  expect(await reviewSnapshot(database.db, { ...command, auditId: "loser" })).toEqual({
    outcome: "ignored",
  });
  // A reused success receipt must fail rather than authorize another batch's writes.
  await expect(reviewSnapshot(database.db, command)).rejects.toThrow(/UNIQUE constraint/);
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual(before);
  expect(database.sqlite.prepare("SELECT id FROM ugc_snapshots_review_audit").all()).toEqual([
    { id: "receipt" },
  ]);
});
