import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { insertUser } from "@/test/fixtures/users";
import type { AuthUser } from "@/types/app";

import { setImageUpvote, setSubmissionVote } from "./voteSubmission";

let database: TestDatabase;
const actor: AuthUser = {
  uid: "reader",
  publicUid: "1AA",
  role: "n",
  karma: 0,
  avatar: 0,
  email: "reader@example.test",
  nickname: "Reader",
  needsProfileSetup: false,
};
beforeEach(() => {
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "author" });
  insertUser(database.sqlite, { uid: actor.uid });
});
afterEach(() => database.close());

it("leaves votes and expired notification groups untouched when hiding commits before a comment vote", async () => {
  insertCommentSnapshot(database.sqlite, { id: "comment", userId: "author" });
  await setSubmissionVote(database.db, { submissionId: "comment", actor, value: 1 });
  database.sqlite.exec(
    "UPDATE notifications SET window_expires_at='2000-01-01'; UPDATE ugc_submissions SET author_deleted_at='gone'",
  );
  const votes = database.sqlite.prepare("SELECT * FROM ugc_submission_votes").all();
  const notifications = database.sqlite.prepare("SELECT * FROM notifications").all();
  expect(
    await setSubmissionVote(database.db, { submissionId: "comment", actor, value: -1 }),
  ).toEqual({ outcome: "hidden" });
  expect(database.sqlite.prepare("SELECT * FROM ugc_submission_votes").all()).toEqual(votes);
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual(notifications);
  expect(
    database.sqlite.prepare("SELECT count(*) AS count FROM notification_messages").get(),
  ).toEqual({ count: 1 });
});

it("leaves image likes and notification groups untouched for a set or cancel after deletion", async () => {
  insertImageSnapshot(database.sqlite, { id: "image", userId: "author" });
  await setImageUpvote(database.db, { submissionId: "image", actor, active: true });
  database.sqlite.exec(
    "UPDATE notifications SET window_expires_at='2000-01-01'; UPDATE ugc_submissions SET author_deleted_at='gone'",
  );
  const votes = database.sqlite.prepare("SELECT * FROM ugc_submission_upvotes").all();
  const notifications = database.sqlite.prepare("SELECT * FROM notifications").all();
  for (const active of [true, false]) {
    expect(await setImageUpvote(database.db, { submissionId: "image", actor, active })).toEqual({
      outcome: "hidden",
    });
  }
  expect(database.sqlite.prepare("SELECT * FROM ugc_submission_upvotes").all()).toEqual(votes);
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual(notifications);
});
