import { expect, it } from "vitest";

import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertUser } from "@/test/fixtures/users";

import { createPendingComment } from "./createComment";

it("rechecks parent visibility when inserting and leaves neither reply identity nor snapshot", async () => {
  const database = createTestDatabase();
  try {
    insertUser(database.sqlite, { uid: "author" });
    insertCommentSnapshot(database.sqlite, { id: "parent", userId: "author" });
    // The caller selected this parent while it was public; deletion commits first.
    database.sqlite.exec("UPDATE ugc_submissions SET author_deleted_at='gone' WHERE id='parent'");
    expect(
      await createPendingComment(database.db, {
        id: "reply",
        snapshotId: "reply-version",
        userId: "author",
        parentId: "parent",
        markerId: "marker-1",
        poiHash: "hash",
        poiType: "poi",
        content: "Reply",
      }),
    ).toEqual({ outcome: "parent_hidden" });
    expect(database.sqlite.prepare("SELECT id FROM ugc_submissions").all()).toEqual([
      { id: "parent" },
    ]);
    expect(database.sqlite.prepare("SELECT id FROM ugc_snapshots").all()).toEqual([
      { id: "snapshot-parent" },
    ]);
  } finally {
    database.close();
  }
});
