import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { migrations } from "@/test/database/migrations";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { insertSubmission as seedSubmission } from "@/test/fixtures/submissions";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";

import {
  decodeNotificationCursor,
  getNotificationUnreadCounts,
  listNotifications,
  markNotificationRead,
  markNotificationsRead,
  prepareApprovedReplyNotificationWrite,
  prepareCommentVoteNotificationWrite,
  prepareSubmissionStatusNotificationWrite,
  serializeNotificationItem,
  type TransitionNotificationPayload,
} from "./notifications";
import { archiveTestImageSubmissions } from "./submission-review";
import { transitionSubmissionStatusWithNotifications } from "./submission/statusSubmission";
import type { SubmissionRecord, SubmissionStatus } from "./submission/types";
import { setImageUpvote } from "./submission/voteSubmission";

const submission = (id: string, updatedAt: string): SubmissionRecord => ({
  id,
  kind: "image",
  markerId: `marker-${id}`,
  poiHash: `hash-${id}`,
  poiType: "type-1",
  snapshotId: `snapshot-${id}`,
  userId: "user-1",
  content: null,
  editOriginalContent: null,
  editOriginalStatus: null,
  editOriginalSnapshotId: null,
  filePath: `${id}.webp`,
  status: "pending_openai",
  flagCount: 0,
  moderationNote: null,
  moderationQueuedAt: null,
  mimeType: "image/webp",
  sizeBytes: 1,
  parentId: null,
  commentDepth: 0,
  submitter: null,
  createdAt: updatedAt,
  updatedAt,
});

const transition = (
  item: SubmissionRecord,
  transitionedAt: string,
  nextStatus: SubmissionStatus = "active",
  previousStatus: SubmissionStatus = "pending_openai",
): TransitionNotificationPayload => ({
  submission: item,
  previousStatus,
  nextStatus,
  source: "auto_moderation",
  transitionedAt,
});

const comment = (
  id: string,
  userId: string,
  parentId: string | null,
  updatedAt: string,
  nickname: string,
): SubmissionRecord => ({
  ...submission(id, updatedAt),
  kind: "comment",
  userId,
  parentId,
  content: `Comment ${id}`,
  filePath: null,
  mimeType: null,
  sizeBytes: null,
  submitter: {
    uid: userId,
    uidNumber: null,
    publicUid: `public-${userId}`,
    role: "n",
    karma: 0,
    nickname,
    avatar: 1,
  },
});

function persistSubmission(
  database: TestDatabase,
  item: SubmissionRecord,
  status: SubmissionStatus,
) {
  seedSubmission(database.sqlite, {
    id: item.id,
    userId: item.userId,
    kind: item.kind,
    markerId: item.markerId,
    poiHash: item.poiHash,
    poiType: item.poiType,
    snapshotId: item.snapshotId,
    status,
    content: item.content,
    filePath: item.filePath,
    parentId: item.parentId,
    depth: item.commentDepth,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    mimeType: item.mimeType,
  });
}

describe("notification aggregation SQL", () => {
  let database: TestDatabase | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("counts one unread container, reopens it after read, and starts a new fixed window", async () => {
    database = createTestDatabase();
    const db = database.db;
    insertUser(database.sqlite, { uid: "user-1" });

    const write = async (id: string, createdAt: string) => {
      const item = submission(id, createdAt);
      persistSubmission(database!, item, "active");
      await db.batch(prepareSubmissionStatusNotificationWrite(db, transition(item, createdAt)));
    };

    await write("1", "2026-08-02T10:00:00.000Z");
    await db.batch(
      prepareSubmissionStatusNotificationWrite(
        db,
        transition(submission("1", "2026-08-02T10:00:00.000Z"), "2026-08-02T10:00:00.000Z"),
      ),
    );
    await write("2", "2026-08-02T10:00:30.000Z");

    let listed = await listNotifications(db, { userId: "user-1", category: "system", limit: 20 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.messages).toHaveLength(2);
    expect(serializeNotificationItem(listed.items[0]!).payload).toEqual({
      kind: "image",
      messageCount: 2,
    });
    expect(await getNotificationUnreadCounts(db, "user-1")).toEqual({
      system: 1,
      community: 0,
      total: 1,
    });

    await markNotificationRead(db, {
      userId: "user-1",
      category: "system",
      id: listed.items[0]!.id,
    });
    expect((await getNotificationUnreadCounts(db, "user-1")).total).toBe(0);

    await write("3", "2026-08-02T10:00:45.000Z");
    listed = await listNotifications(db, { userId: "user-1", category: "system", limit: 20 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.messages).toHaveLength(3);
    expect((await getNotificationUnreadCounts(db, "user-1")).total).toBe(1);

    await write("4", "2026-08-02T10:01:00.000Z");
    listed = await listNotifications(db, { userId: "user-1", category: "system", limit: 20 });
    expect(listed.items).toHaveLength(2);
    expect((await getNotificationUnreadCounts(db, "user-1")).total).toBe(2);

    const firstPage = await listNotifications(db, {
      userId: "user-1",
      category: "system",
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listNotifications(db, {
      userId: "user-1",
      category: "system",
      limit: 1,
      cursor: decodeNotificationCursor(firstPage.nextCursor ?? undefined),
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);

    const changed = await markNotificationsRead(db, {
      userId: "user-1",
      category: "system",
      ids: [
        firstPage.items[0]!.id,
        secondPage.items[0]!.id,
        firstPage.items[0]!.id,
        "missing-notification",
      ],
    });
    expect(changed).toBe(2);
    expect(await getNotificationUnreadCounts(db, "user-1")).toEqual({
      system: 0,
      community: 0,
      total: 0,
    });
  });

  it("writes all aggregation key variants and keeps unrelated reply and vote groups separate", async () => {
    database = createTestDatabase();
    const db = database.db;
    insertUser(database.sqlite, { uid: "user-1" });
    insertUser(database.sqlite, { uid: "user-2" });
    insertUser(database.sqlite, { uid: "user-3" });

    const review = submission("review", "2026-08-02T11:00:00.000Z");
    const removed = submission("removed", "2026-08-02T11:00:01.000Z");
    const reopenedInitially = submission("reopened", "2026-08-02T11:00:02.000Z");
    persistSubmission(database, review, "pending_audit");
    persistSubmission(database, removed, "stale");
    persistSubmission(database, reopenedInitially, "active");
    await db.batch(
      prepareSubmissionStatusNotificationWrite(
        db,
        transition(review, review.updatedAt, "pending_audit"),
      ),
    );
    await db.batch(
      prepareSubmissionStatusNotificationWrite(
        db,
        transition(removed, removed.updatedAt, "stale", "remove_request"),
      ),
    );
    await db.batch(
      prepareSubmissionStatusNotificationWrite(
        db,
        transition(reopenedInitially, reopenedInitially.updatedAt),
      ),
    );
    const reopenedResolved = {
      ...reopenedInitially,
      updatedAt: "2026-08-02T11:00:20.000Z",
    };
    database.sqlite
      .prepare("UPDATE ugc_submissions SET updated_at = ? WHERE id = ?")
      .run(reopenedResolved.updatedAt, reopenedResolved.id);
    await db.batch(
      prepareSubmissionStatusNotificationWrite(
        db,
        transition(reopenedResolved, reopenedResolved.updatedAt, "active", "remove_request"),
      ),
    );

    const parent1 = comment("parent-1", "user-1", null, "2026-08-02T11:01:00.000Z", "Owner");
    const parent2 = comment("parent-2", "user-1", null, "2026-08-02T11:01:00.000Z", "Owner");
    const reply1 = comment("reply-1", "user-2", parent1.id, "2026-08-02T11:01:01.000Z", "Alice");
    const reply2 = comment("reply-2", "user-3", parent1.id, "2026-08-02T11:01:20.000Z", "Bob");
    const reply3 = comment("reply-3", "user-2", parent2.id, "2026-08-02T11:01:21.000Z", "Alice");
    for (const item of [parent1, parent2, reply1, reply2, reply3]) {
      persistSubmission(database, item, "active");
    }
    for (const item of [reply1, reply2, reply3]) {
      await db.batch(prepareApprovedReplyNotificationWrite(db, transition(item, item.updatedAt)));
    }

    const voteTarget = comment("vote-target", "user-1", null, "2026-08-02T11:02:00.000Z", "Owner");
    persistSubmission(database, voteTarget, "active");
    const actors = [
      {
        uid: "user-2",
        publicUid: "public-user-2",
        nickname: "Alice",
        avatar: 1,
        email: "alice@example.com",
        role: "n" as const,
        karma: 0,
        needsProfileSetup: false,
      },
      {
        uid: "user-3",
        publicUid: "public-user-3",
        nickname: "Bob",
        avatar: 2,
        email: "bob@example.com",
        role: "n" as const,
        karma: 0,
        needsProfileSetup: false,
      },
    ];
    for (const [index, actor] of actors.entries()) {
      const changedAt = `2026-08-02T11:02:${String(index * 20).padStart(2, "0")}.000Z`;
      database.sqlite
        .prepare(
          `INSERT INTO ugc_submission_votes (
           submission_id, user_id, value, active, created_at, updated_at
         ) VALUES (?, ?, 1, 1, ?, ?)`,
        )
        .run(voteTarget.id, actor.uid, changedAt, changedAt);
      await db.batch(
        prepareCommentVoteNotificationWrite(db, {
          submissionId: voteTarget.id,
          actor,
          value: 1,
          changedAt,
        }),
      );
    }

    const system = await listNotifications(db, { userId: "user-1", category: "system", limit: 20 });
    expect(system.items.map((item) => item.type).sort()).toEqual([
      "system.submission.approved",
      "system.submission.needs_review",
    ]);
    expect(system.items.some((item) => item.type === "system.remove_request.resolved")).toBe(false);

    const community = await listNotifications(db, {
      userId: "user-1",
      category: "community",
      limit: 20,
    });
    expect(community.items).toHaveLength(3);
    const replyGroups = community.items.filter((item) => item.type === "community.comment.reply");
    const voteGroup = community.items.find((item) => item.type === "community.comment.vote");
    expect(replyGroups.map((item) => item.messages.length).sort()).toEqual([1, 2]);
    expect(voteGroup?.messages).toHaveLength(2);
    expect(voteGroup && serializeNotificationItem(voteGroup).payload).toEqual({
      kind: "comment",
      messageCount: 2,
    });
    expect(await getNotificationUnreadCounts(db, "user-1")).toEqual({
      system: 2,
      community: 3,
      total: 5,
    });
  });

  it("aggregates likes for six hours per target while replies keep the one-minute window", async () => {
    database = createTestDatabase();
    const db = database.db;
    insertUser(database.sqlite, { uid: "owner" });
    insertUser(database.sqlite, { uid: "actor-1" });
    insertUser(database.sqlite, { uid: "actor-2" });
    insertUser(database.sqlite, { uid: "actor-3" });
    insertUser(database.sqlite, { uid: "actor-4" });

    const actor = (uid: string) => ({
      uid,
      publicUid: `public-${uid}`,
      nickname: uid,
      avatar: 1,
      email: `${uid}@example.com`,
      role: "n" as const,
      karma: 0,
      needsProfileSetup: false,
    });
    const addVote = async (targetId: string, uid: string, changedAt: string) => {
      database?.sqlite
        .prepare(
          `INSERT INTO ugc_submission_votes (
           submission_id, user_id, value, active, created_at, updated_at
         ) VALUES (?, ?, 1, 1, ?, ?)`,
        )
        .run(targetId, uid, changedAt, changedAt);
      await db.batch(
        prepareCommentVoteNotificationWrite(db, {
          submissionId: targetId,
          actor: actor(uid),
          value: 1,
          changedAt,
        }),
      );
    };

    const voteTarget1 = comment(
      "vote-target-1",
      "owner",
      null,
      "2026-08-02T00:00:00.000Z",
      "Owner",
    );
    const voteTarget2 = comment(
      "vote-target-2",
      "owner",
      null,
      "2026-08-02T00:00:00.000Z",
      "Owner",
    );
    persistSubmission(database, voteTarget1, "active");
    persistSubmission(database, voteTarget2, "active");
    await addVote(voteTarget1.id, "actor-1", "2026-08-02T00:00:00.000Z");
    await addVote(voteTarget1.id, "actor-2", "2026-08-02T05:59:59.999Z");
    await addVote(voteTarget1.id, "actor-3", "2026-08-02T06:00:00.000Z");
    await addVote(voteTarget2.id, "actor-4", "2026-08-02T01:00:00.000Z");

    const parent = comment("reply-parent", "owner", null, "2026-08-02T10:00:00.000Z", "Owner");
    const reply1 = comment("reply-1m", "actor-1", parent.id, "2026-08-02T10:00:00.000Z", "Actor 1");
    const reply2 = comment("reply-2m", "actor-2", parent.id, "2026-08-02T10:01:00.000Z", "Actor 2");
    persistSubmission(database, parent, "active");
    persistSubmission(database, reply1, "active");
    persistSubmission(database, reply2, "active");
    await db.batch(prepareApprovedReplyNotificationWrite(db, transition(reply1, reply1.updatedAt)));
    await db.batch(prepareApprovedReplyNotificationWrite(db, transition(reply2, reply2.updatedAt)));

    const listed = await listNotifications(db, {
      userId: "owner",
      category: "community",
      limit: 20,
    });
    const voteGroups = listed.items.filter((item) => item.type === "community.comment.vote");
    const replyGroups = listed.items.filter((item) => item.type === "community.comment.reply");
    expect(voteGroups).toHaveLength(3);
    expect(voteGroups.map((item) => item.messages.length).sort()).toEqual([1, 1, 2]);
    expect(replyGroups).toHaveLength(2);
    expect(replyGroups.map((item) => item.messages.length)).toEqual([1, 1]);
  });

  it("retires new removal notifications while keeping historical resolution messages readable", async () => {
    database = createTestDatabase();
    const db = database.db;
    insertUser(database.sqlite, { uid: "owner" });
    database.sqlite.exec(`
      INSERT INTO ugc_submissions (file_path,
        id, user_id, poi_id, poi_hash, poi_type, snapshot_id,
        status, updated_at, kind, moderation_note
      ) VALUES ('fixture.webp', 'remove-1', 'owner', 'marker-1', 'hash-1', 'type-1', 'snapshot-1',
        'active', '2026-08-02T12:00:00.000Z', 'image', NULL
      );
    `);

    const current = {
      ...submission("remove-1", "2026-08-02T12:00:00.000Z"),
      userId: "owner",
      snapshotId: "snapshot-1",
      status: "active" as const,
      moderationNote: null,
    };
    const result = await transitionSubmissionStatusWithNotifications(db, {
      submission: current,
      status: "stale",
      moderationNote: "Recalled by uploader.",
      source: "user_action",
    });

    expect(
      database.sqlite.prepare("SELECT from_status, to_status, source FROM ugc_review_events").all(),
    ).toEqual([{ from_status: "active", to_status: "stale", source: "user_action" }]);
    const conflict = await transitionSubmissionStatusWithNotifications(db, {
      submission: current,
      status: "stale",
      source: "manual_moderation",
    });
    expect(conflict.updated).toBe(false);
    expect(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM ugc_review_events").get(),
    ).toEqual({ count: 1 });
    database.sqlite.exec(
      "UPDATE ugc_submissions SET status = 'pending_openai' WHERE id = 'remove-1'",
    );
    const manualArchive = await transitionSubmissionStatusWithNotifications(db, {
      submission: { ...current, status: "pending_openai" },
      status: "stale",
      source: "manual_moderation",
    });
    expect(manualArchive.updated).toBe(true);
    expect(manualArchive.notifications).toEqual([]);
    expect(
      database.sqlite
        .prepare(
          "SELECT from_status, to_status, source FROM ugc_review_events ORDER BY id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      from_status: "pending_openai",
      to_status: "stale",
      source: "manual_moderation",
    });
    expect(result.updated).toBe(true);
    expect(result.notifications).toEqual([]);
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM notifications").get()).toEqual({
      count: 0,
    });
    // Pre-cutover messages remain readable; retirement only stops new generation.
    database.sqlite.exec(`INSERT INTO notifications
      (id,recipient_user_id,category,type,payload_json,dedupe_key,created_at)
      VALUES ('historical','owner','system','system.remove_request.resolved','{"kind":"image"}','historical','2026-08-02T12:00:00.000Z')`);
    const listed = await listNotifications(db, { userId: "owner", category: "system", limit: 20 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.type).toBe("system.remove_request.resolved");
  });

  it("records bulk manual archives atomically and respects escaped prefixes", async () => {
    database = createTestDatabase();
    const db = database.db;
    insertUser(database.sqlite, { uid: "owner" });
    seedSubmission(database.sqlite, {
      id: "mine",
      userId: "owner",
      kind: "image",
      snapshotId: "v1-mine",
      status: "pending_openai",
      filePath: "test_a/a.webp",
      updatedAt: "old",
      markerId: "point1",
    });
    seedSubmission(database.sqlite, {
      id: "other",
      userId: "owner",
      kind: "image",
      snapshotId: "v1-other",
      filePath: "testXa/b.webp",
      updatedAt: "old",
      markerId: "point2",
    });
    insertUser(database.sqlite, { uid: "admin", role: "a" });
    importCurrentSubmissions(database);
    expect(
      await archiveTestImageSubmissions(db, { prefix: "test_a", adminUserId: "admin" }),
    ).toEqual({ changedRows: 1, markerIds: ["point1"] });
    expect(
      database.sqlite.prepare("SELECT admin_deleted_by FROM ugc_submissions WHERE id='mine'").get(),
    ).toEqual({ admin_deleted_by: "admin" });
    expect(
      database.sqlite
        .prepare("SELECT review_status FROM ugc_snapshots WHERE submission_id='mine'")
        .get(),
    ).toEqual({ review_status: "pending_openai" });
    expect(
      database.sqlite
        .prepare("SELECT admin_deleted_at FROM ugc_submissions WHERE id='other'")
        .get(),
    ).toEqual({ admin_deleted_at: null });
    expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual([]);
  });

  it("notifies image owners for a new upvote, ignores duplicates, and suppresses self-upvotes", async () => {
    database = createTestDatabase();
    const db = database.db;
    insertUser(database.sqlite, { uid: "owner" });
    insertUser(database.sqlite, { uid: "actor" });
    importCurrentSubmissions(database);
    insertImageSnapshot(database.sqlite, { id: "image-1", userId: "owner" });
    insertImageSnapshot(database.sqlite, { id: "image-self", userId: "actor" });

    const actor = {
      uid: "actor",
      publicUid: "public-actor",
      nickname: "Actor",
      avatar: 1,
      email: "actor@example.com",
      role: "n" as const,
      karma: 0,
      needsProfileSetup: false,
    };
    const first = await setImageUpvote(db, { submissionId: "image-1", actor, active: true });
    const duplicate = await setImageUpvote(db, { submissionId: "image-1", actor, active: true });
    const self = await setImageUpvote(db, { submissionId: "image-self", actor, active: true });

    if (
      first.outcome !== "committed" ||
      duplicate.outcome !== "committed" ||
      self.outcome !== "committed"
    ) {
      throw new Error("Expected visible image votes");
    }
    expect(first.changed).toBe(true);
    expect(first.notifications).toHaveLength(1);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.notifications).toHaveLength(0);
    expect(self.changed).toBe(true);
    expect(self.notifications).toHaveLength(0);

    const listed = await listNotifications(db, {
      userId: "owner",
      category: "community",
      limit: 20,
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.type).toBe("community.comment.vote");
    expect(listed.items[0] && serializeNotificationItem(listed.items[0]).payload).toEqual({
      kind: "image",
    });
    expect(await getNotificationUnreadCounts(db, "owner")).toEqual({
      system: 0,
      community: 1,
      total: 1,
    });
  });

  it("removes legacy rejected notifications and lets the delete trigger repair unread counters", async () => {
    database = createTestDatabase(migrations.filter((file) => file < "0030"));
    insertUser(database.sqlite, { uid: "user-1" });
    database.sqlite.exec(`
      INSERT INTO notifications (
        id, recipient_user_id, category, type, payload_json, dedupe_key, created_at
      ) VALUES
        ('legacy-rejected', 'user-1', 'system', 'system.submission.rejected', '{}', 'legacy-rejected', '2026-08-02T10:00:00.000Z'),
        ('legacy-approved', 'user-1', 'system', 'system.submission.approved', '{"kind":"image"}', 'legacy-approved', '2026-08-02T10:00:01.000Z');
    `);

    expect(
      database.sqlite
        .prepare("SELECT system_unread FROM notification_counters WHERE user_id = 'user-1'")
        .get(),
    ).toEqual({ system_unread: 2 });

    database.sqlite.exec(
      readFileSync(
        new URL("../../migrations/0030_notification_aggregation.sql", import.meta.url),
        "utf8",
      ),
    );

    expect(database.sqlite.prepare("SELECT id FROM notifications ORDER BY id").all()).toEqual([
      { id: "legacy-approved" },
    ]);
    expect(
      database.sqlite
        .prepare("SELECT system_unread FROM notification_counters WHERE user_id = 'user-1'")
        .get(),
    ).toEqual({ system_unread: 1 });
  });
});
