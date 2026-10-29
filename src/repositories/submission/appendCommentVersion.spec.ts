import { expect, it } from "vitest";

import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertUser } from "@/test/fixtures/users";

import { appendCommentVersion } from "./appendCommentVersion";

it("allows only one append from the same parent without consuming a revision for the loser", async () => {
  const database = createTestDatabase();
  try {
    insertUser(database.sqlite, { uid: "author" });
    insertCommentSnapshot(database.sqlite, { id: "comment", userId: "author", snapshotId: "A" });
    const input = {
      submissionId: "comment",
      parentSnapshotId: "A",
      actorId: "author",
      content: "Changed",
    };
    // D1 batches serialize writes. Exercise the two possible commits in that order.
    expect(await appendCommentVersion(database.db, { ...input, snapshotId: "B" })).toMatchObject({
      outcome: "appended",
    });
    expect(await appendCommentVersion(database.db, { ...input, snapshotId: "C" })).toEqual({
      outcome: "conflict",
    });
    expect(database.sqlite.prepare("SELECT revision FROM ugc_submissions").get()).toEqual({
      revision: 2,
    });
    expect(
      database.sqlite.prepare("SELECT id,revision FROM ugc_snapshots ORDER BY revision").all(),
    ).toEqual([
      { id: "A", revision: 1 },
      { id: "B", revision: 2 },
    ]);
  } finally {
    database.close();
  }
});
