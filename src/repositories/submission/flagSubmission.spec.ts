import { expect, it } from "vitest";

import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertUser } from "@/test/fixtures/users";

import { setSubmissionReport } from "./flagSubmission";

it("rejects both stale report directions, including no-ops, after public replacement commits", async () => {
  const database = createTestDatabase();
  try {
    insertUser(database.sqlite, { uid: "author" });
    insertUser(database.sqlite, { uid: "reader" });
    insertCommentSnapshot(database.sqlite, { id: "comment", snapshotId: "A", userId: "author" });
    database.sqlite
      .exec(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,content,review_status,creator_user_id)
      VALUES ('B','comment','comment',2,'Replacement','approved','author');
      UPDATE ugc_submissions SET revision=2`);
    for (const active of [true, false]) {
      expect(
        await setSubmissionReport(database.db, {
          submissionId: "comment",
          snapshotId: "A",
          kind: "comment",
          userId: "reader",
          active,
        }),
      ).toEqual({ outcome: "conflict" });
    }
    expect(database.sqlite.prepare("SELECT * FROM ugc_submission_flags").all()).toEqual([]);
  } finally {
    database.close();
  }
});
