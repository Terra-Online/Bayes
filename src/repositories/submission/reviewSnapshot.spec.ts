import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertUser } from "@/test/fixtures/users";

import {
  getReviewTarget,
  reviewSnapshot,
  type ReviewCommand,
  type ReviewTarget,
} from "./reviewSnapshot";

let database: TestDatabase;
let target: ReviewTarget;
beforeEach(async () => {
  database = createTestDatabase();

  insertUser(database.sqlite, { uid: "author", uid_number: 100 });
  insertUser(database.sqlite, { uid: "admin", uid_number: 101, role: "p" });
  insertCommentSnapshot(database.sqlite, {
    id: "comment",
    userId: "author",
    reviewStatus: "pending_openai",
  });
  const selected = await getReviewTarget(database.db, "comment", "snapshot-comment");
  if (!selected) {
    throw new Error("Missing test target");
  }
  target = selected;
});
afterEach(() => database.close());

it.each([
  ["pending_openai", "approved", true],
  ["pending_openai", "rejected", true],
  ["pending_openai", "pending_audit", true],
  ["pending_audit", "approved", true],
  ["pending_audit", "rejected", true],
  ["pending_audit", "pending_audit", false],
  ["approved", "rejected", false],
  ["rejected", "approved", false],
  ["unknown", "approved", false],
] as const)(
  "admin %s to %s has committed=%s with actual attribution",
  async (from, to, committed) => {
    database.sqlite.prepare("UPDATE ugc_snapshots SET review_status=?").run(from);
    const result = await reviewSnapshot(database.db, {
      target,
      expectedReviewStatus: from,
      decision: to,
      source: "admin",
      adminUserId: "admin",
      auditId: "admin-decision",
    });
    expect(result.outcome).toBe(committed ? "committed" : "ignored");
    expect(
      database.sqlite
        .prepare(
          "SELECT source,admin_user_id,from_status,to_status FROM ugc_snapshots_review_audit",
        )
        .all(),
    ).toEqual(
      committed
        ? [{ source: "admin", admin_user_id: "admin", from_status: from, to_status: to }]
        : [],
    );
    if (result.outcome === "committed") {
      expect(result.firstApproval).toBe(to === "approved");
      expect(result.notifications).toHaveLength(to === "rejected" ? 0 : 1);
    }
  },
);

it("checks expected phase and reviewer authority inside the transaction", async () => {
  const base = {
    target,
    decision: "approved",
    source: "admin",
    adminUserId: "admin",
    auditId: "receipt",
  } as const;
  expect(
    await reviewSnapshot(database.db, { ...base, expectedReviewStatus: "pending_audit" }),
  ).toEqual({ outcome: "ignored" });
  database.sqlite.exec("UPDATE users SET role='n' WHERE uid='admin'");
  expect(
    await reviewSnapshot(database.db, { ...base, expectedReviewStatus: "pending_openai" }),
  ).toEqual({ outcome: "ignored" });
  expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual([]);
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
});

it("rejects receipt reuse on both eligible and stale targets without borrowing earlier success", async () => {
  const command: ReviewCommand = {
    target,
    expectedReviewStatus: "pending_openai",
    decision: "approved",
    source: "ai",
    auditId: "receipt",
  };
  expect(await reviewSnapshot(database.db, command)).toMatchObject({
    outcome: "committed",
    firstApproval: true,
  });
  insertCommentSnapshot(database.sqlite, {
    id: "other",
    userId: "author",
    reviewStatus: "pending_openai",
  });
  const other = await getReviewTarget(database.db, "other");
  if (!other) {
    throw new Error("Missing other target");
  }
  const before = database.sqlite.prepare("SELECT * FROM notifications").all();
  await expect(reviewSnapshot(database.db, { ...command, target: other })).rejects.toThrow(
    /UNIQUE constraint/,
  );
  await expect(reviewSnapshot(database.db, command)).rejects.toThrow(/UNIQUE constraint/);
  expect(
    database.sqlite
      .prepare("SELECT review_status FROM ugc_snapshots WHERE id='snapshot-other'")
      .get(),
  ).toEqual({ review_status: "pending_openai" });
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual(before);
  expect(database.sqlite.prepare("SELECT id FROM ugc_snapshots_review_audit").all()).toEqual([
    { id: "receipt" },
  ]);
});

it("does not expire an aggregation group when a stale receipt attempt is ignored", async () => {
  const command: ReviewCommand = {
    target,
    expectedReviewStatus: "pending_openai",
    decision: "approved",
    source: "ai",
    auditId: "receipt",
  };
  await reviewSnapshot(database.db, command);
  database.sqlite.exec("UPDATE notifications SET window_expires_at='2000-01-01T00:00:00Z'");
  const before = database.sqlite.prepare("SELECT * FROM notifications").all();
  expect(await reviewSnapshot(database.db, { ...command, auditId: "duplicate" })).toEqual({
    outcome: "ignored",
  });
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual(before);
  expect(database.sqlite.prepare("SELECT id FROM ugc_snapshots_review_audit").all()).toEqual([
    { id: "receipt" },
  ]);
});
