import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

import {
  getSubmissionById,
  revertCommentEdit,
  transitionSubmissionStatusWithNotifications,
  updateCommentContentForModeration,
} from "./statusSubmission";

let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "author" });
});
afterEach(() => database.close());

function storedState() {
  return {
    submissions: database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all(),
    reviews: database.sqlite.prepare("SELECT * FROM ugc_review_events ORDER BY id").all(),
    notifications: database.sqlite.prepare("SELECT * FROM notifications ORDER BY id").all(),
    messages: database.sqlite.prepare("SELECT * FROM notification_messages ORDER BY id").all(),
  };
}

function edit(expectedSnapshotId: string, snapshotId: string, content: string) {
  return updateCommentContentForModeration(database.db, {
    id: "comment",
    expectedSnapshotId,
    snapshotId,
    content,
    moderationNote: "Edited, awaiting moderation.",
  });
}

describe("submission snapshot conflicts", () => {
  it("preserves the winning edit and its undo version when another edit uses an old snapshot, then accepts a refreshed retry", async () => {
    insertSubmission(database.sqlite, {
      id: "comment",
      userId: "author",
      content: "Original directions",
    });
    expect(await edit("snapshot-comment", "first-edit", "East entrance")).toBe(true);
    const winner = storedState();
    expect(await edit("snapshot-comment", "late-edit", "West entrance")).toBe(false);
    expect(storedState()).toEqual(winner);
    expect(winner.submissions[0]).toMatchObject({
      content: "East entrance",
      snapshot_id: "first-edit",
      edit_original_content: "Original directions",
      edit_original_snapshot_id: "snapshot-comment",
    });
    const refreshed = (await getSubmissionById(database.db, "comment"))!;
    expect(await edit(refreshed.snapshotId, "retry-edit", "West entrance")).toBe(true);
    expect(storedState().submissions[0]).toMatchObject({
      content: "West entrance",
      snapshot_id: "retry-edit",
      edit_original_content: "East entrance",
      edit_original_snapshot_id: "first-edit",
      status: "pending_openai",
    });
  });

  it("rejects a late undo without discarding a newer revision and lets a refreshed undo restore its saved version", async () => {
    insertSubmission(database.sqlite, {
      id: "comment",
      userId: "author",
      content: "Original directions",
    });
    await edit("snapshot-comment", "first-edit", "East entrance");
    const undoTarget = (await getSubmissionById(database.db, "comment"))!;
    await edit("first-edit", "newer-edit", "West entrance");
    const newer = storedState();
    const undo = (expectedSnapshotId: string) =>
      revertCommentEdit(database.db, {
        id: "comment",
        expectedSnapshotId,
        status: "pending_openai",
        moderationNote: "Comment edit reverted by author.",
      });
    expect(await undo(undoTarget.snapshotId)).toBe(false);
    expect(storedState()).toEqual(newer);
    expect(await undo((await getSubmissionById(database.db, "comment"))!.snapshotId)).toBe(true);
    expect(storedState().submissions[0]).toMatchObject({
      content: "East entrance",
      snapshot_id: "first-edit",
      edit_original_content: null,
      edit_original_status: null,
      edit_original_snapshot_id: null,
    });
  });

  it.each(["comment", "image"] as const)(
    "does not recall a changed %s snapshot or notify its owner until a refreshed retry succeeds",
    async (kind) => {
      insertSubmission(database.sqlite, { id: "target", userId: "author", kind });
      const original = (await getSubmissionById(database.db, "target"))!;
      // Another committed version wins before this client's conditional transition.
      if (kind === "comment") {
        await updateCommentContentForModeration(database.db, {
          id: "target",
          expectedSnapshotId: original.snapshotId,
          snapshotId: "newer-snapshot",
          content: "New directions",
          moderationNote: "Edited, awaiting moderation.",
        });
      } else {
        await transitionSubmissionStatusWithNotifications(database.db, {
          submission: original,
          status: "flagged",
          source: "user_action",
        });
      }
      const newer = storedState();
      expect(
        await transitionSubmissionStatusWithNotifications(database.db, {
          submission: original,
          status: "stale",
          source: "user_action",
          moderationNote: "Recalled by author.",
        }),
      ).toEqual({ updated: false, notifications: [] });
      expect(storedState()).toEqual(newer);
      const current = (await getSubmissionById(database.db, "target"))!;
      const retry = await transitionSubmissionStatusWithNotifications(database.db, {
        submission: current,
        status: "stale",
        source: "user_action",
        moderationNote: "Recalled by author.",
      });
      expect(retry.updated).toBe(true);
      expect(retry.notifications).toHaveLength(1);
      expect(storedState().submissions[0]).toMatchObject({
        content: kind === "comment" ? "New directions" : "Content target",
        snapshot_id: current.snapshotId,
        status: "stale",
      });
      expect(
        database.sqlite
          .prepare(
            "SELECT snapshot_id, from_status, to_status FROM ugc_review_events WHERE to_status = 'stale'",
          )
          .all(),
      ).toEqual([
        { snapshot_id: current.snapshotId, from_status: current.status, to_status: "stale" },
      ]);
      expect(
        database.sqlite.prepare("SELECT recipient_user_id, submission_id FROM notifications").all(),
      ).toEqual([{ recipient_user_id: "author", submission_id: "target" }]);
      expect(
        await transitionSubmissionStatusWithNotifications(database.db, {
          submission: current,
          status: "stale",
          source: "user_action",
        }),
      ).toEqual({ updated: false, notifications: [] });
      expect(storedState().reviews).toHaveLength(kind === "comment" ? 1 : 2);
      expect(storedState().messages).toHaveLength(1);
    },
  );
});
