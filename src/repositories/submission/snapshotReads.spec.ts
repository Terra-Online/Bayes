import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertSubmission } from "@/test/fixtures/submissions";
import { importCurrentSubmissions, legacySnapshotSeedSql } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";

import { getPublicSnapshot, getOwnerSnapshot } from "./snapshotReads";

let database: ReturnType<typeof createTestDatabase>;
beforeEach(() => {
  database = createTestDatabase();
});
afterEach(() => database.close());

describe("fixed content snapshot single reads", () => {
  it("returns the public body and its original snapshot identity after import", async () => {
    insertUser(database.sqlite, { uid: "owner" });
    insertSubmission(database.sqlite, {
      id: "comment",
      userId: "owner",
      content: "Published A",
      snapshotId: "A",
    });
    importCurrentSubmissions(database);

    expect(await getPublicSnapshot(database.db, "comment")).toMatchObject({
      id: "comment",
      snapshotId: "A",
      content: "Published A",
      status: "active",
      reviewStatus: "approved",
    });
    expect(
      await getOwnerSnapshot(database.db, { id: "comment", ownerUserId: "owner" }),
    ).toMatchObject({
      snapshotId: "A",
      content: "Published A",
      canEdit: true,
    });
    expect(
      await getOwnerSnapshot(database.db, { id: "comment", ownerUserId: "stranger" }),
    ).toBeNull();
  });
  it("shows public A and private pending B without confusing their identities or statuses", async () => {
    database.sqlite.exec(legacySnapshotSeedSql);
    importCurrentSubmissions(database);
    database.sqlite.exec(`INSERT INTO ugc_snapshots
      (id,submission_id,kind,revision,content,review_status,creator_user_id)
      VALUES ('B','comment-active','comment',2,'Private B','pending_audit','owner');
      UPDATE ugc_submissions SET revision=2 WHERE id='comment-active';`);
    expect(await getPublicSnapshot(database.db, "comment-active")).toMatchObject({
      snapshotId: "snap-comment-active",
      content: "Current A",
      status: "active",
      revision: 1,
    });
    expect(
      await getOwnerSnapshot(database.db, { id: "comment-active", ownerUserId: "owner" }),
    ).toMatchObject({
      snapshotId: "B",
      content: "Private B",
      status: "pending_audit",
      revision: 2,
      canEdit: false,
    });
    expect(await getPublicSnapshot(database.db, "image-pending_openai")).toBeNull();
    expect(
      await getOwnerSnapshot(database.db, { id: "image-pending_openai", ownerUserId: "owner" }),
    ).toMatchObject({
      snapshotId: "snap-image-pending_openai",
      filePath: "images/e.webp",
      status: "pending_openai",
      canEdit: false,
    });
    database.sqlite.exec("UPDATE ugc_snapshots SET review_status='rejected' WHERE id='B'");
    expect(await getPublicSnapshot(database.db, "comment-active")).toBeNull();
    expect(
      await getOwnerSnapshot(database.db, { id: "comment-active", ownerUserId: "owner" }),
    ).toMatchObject({
      snapshotId: "B",
      content: "Private B",
      reviewStatus: "rejected",
      status: "stale",
      canEdit: false,
    });
  });

  it("keeps unknown and deleted archives owner-only and derives flags from active reports", async () => {
    database.sqlite.exec(legacySnapshotSeedSql);
    importCurrentSubmissions(database);
    expect(await getPublicSnapshot(database.db, "comment-flagged")).toMatchObject({
      status: "flagged",
      flagCount: 1,
    });
    expect(await getPublicSnapshot(database.db, "comment-remove_request")).toMatchObject({
      status: "active",
    });
    database.sqlite
      .exec(`UPDATE ugc_submissions SET author_deleted_at='deleted' WHERE id='comment-active';
      UPDATE ugc_submissions SET admin_deleted_at='disabled',admin_deleted_by='reader' WHERE id='image-active';`);
    for (const id of ["comment-stale", "comment-active", "image-active"]) {
      expect(await getPublicSnapshot(database.db, id)).toBeNull();
      expect(await getOwnerSnapshot(database.db, { id, ownerUserId: "owner" })).toMatchObject({
        status: "stale",
        canEdit: false,
      });
      expect(await getOwnerSnapshot(database.db, { id, ownerUserId: "reader" })).toBeNull();
    }
    expect(await getPublicSnapshot(database.db, "missing")).toBeNull();
    expect(await getOwnerSnapshot(database.db, { id: "missing", ownerUserId: "owner" })).toBeNull();
  });
});
