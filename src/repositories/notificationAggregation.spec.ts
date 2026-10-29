import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { migrations } from "@/test/database/migrations";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { insertSubmission as seedSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

import {
  decodeNotificationCursor,
  getNotificationUnreadCounts,
  listNotifications,
  markNotificationRead,
  markNotificationsRead,
  prepareCommentVoteNotificationWrite,
  serializeNotificationItem,
} from "./notifications";
import { archiveTestImageSubmissions } from "./submission-review";
import { deleteByAuthor } from "./submission/deleteByAuthor";
import { getReviewTarget, reviewSnapshot } from "./submission/reviewSnapshot";
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
  filePath: `${id}.webp`,
  status: "pending_openai",
  flagCount: 0,
  mimeType: "image/webp",
  sizeBytes: 1,
  parentId: null,
  commentDepth: 0,
  submitter: null,
  createdAt: updatedAt,
  updatedAt,
});

async function reviewDecision(
  database: TestDatabase,
  item: SubmissionRecord,
  at: string,
  decision: "approved" | "pending_audit" = "approved",
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  return reviewSnapshot(database.db, {
    target: (await getReviewTarget(database.db, item.id))!,
    expectedReviewStatus: "pending_openai",
    source: "ai",
    decision,
    auditId: crypto.randomUUID(),
  });
}

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
    vi.useRealTimers();
    database?.close();
    database = null;
  });

  it("counts one unread container, reopens it after read, and starts a new fixed window", async () => {
    database = createTestDatabase();
    const db = database.db;
    insertUser(database.sqlite, { uid: "user-1" });

    const write = async (id: string, createdAt: string) => {
      const item = submission(id, createdAt);
      persistSubmission(database!, item, "pending_openai");
      await reviewDecision(database!, item, createdAt);
    };

    await write("1", "2026-08-02T10:00:00.000Z");
    expect(
      (
        await reviewDecision(
          database,
          submission("1", "2026-08-02T10:00:00.000Z"),
          "2026-08-02T10:00:00.000Z",
        )
      ).outcome,
    ).toBe("ignored");
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
    persistSubmission(database, review, "pending_openai");
    await reviewDecision(database, review, review.updatedAt, "pending_audit");
    const approved = submission("approved", "2026-08-02T11:00:02.000Z");
    persistSubmission(database, approved, "pending_openai");
    await reviewDecision(database, approved, approved.updatedAt);

    const parent1 = comment("parent-1", "user-1", null, "2026-08-02T11:01:00.000Z", "Owner");
    const parent2 = comment("parent-2", "user-1", null, "2026-08-02T11:01:00.000Z", "Owner");
    const reply1 = comment("reply-1", "user-2", parent1.id, "2026-08-02T11:01:01.000Z", "Alice");
    const reply2 = comment("reply-2", "user-3", parent1.id, "2026-08-02T11:01:20.000Z", "Bob");
    const reply3 = comment("reply-3", "user-2", parent2.id, "2026-08-02T11:01:21.000Z", "Alice");
    for (const item of [parent1, parent2, reply1, reply2, reply3]) {
      persistSubmission(database, item, item.parentId ? "pending_openai" : "active");
    }
    for (const item of [reply1, reply2, reply3]) {
      await reviewDecision(database, item, item.updatedAt);
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
    const parent = comment("reply-parent", "owner", null, "2026-08-02T10:00:00.000Z", "Owner");
    const reply1 = comment("reply-1m", "actor-1", parent.id, "2026-08-02T10:00:00.000Z", "Actor 1");
    const reply2 = comment("reply-2m", "actor-2", parent.id, "2026-08-02T10:01:00.000Z", "Actor 2");
    persistSubmission(database, parent, "active");
    persistSubmission(database, reply1, "pending_openai");
    persistSubmission(database, reply2, "pending_openai");
    await reviewDecision(database, reply1, reply1.updatedAt);
    await reviewDecision(database, reply2, reply2.updatedAt);

    await addVote(voteTarget1.id, "actor-1", "2026-08-02T00:00:00.000Z");
    await addVote(voteTarget1.id, "actor-2", "2026-08-02T05:59:59.999Z");
    await addVote(voteTarget1.id, "actor-3", "2026-08-02T06:00:00.000Z");
    await addVote(voteTarget2.id, "actor-4", "2026-08-02T01:00:00.000Z");

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
    seedSubmission(database.sqlite, { id: "remove-1", userId: "owner", kind: "image" });
    expect(
      await deleteByAuthor(db, { submissionId: "remove-1", kind: "image", authorId: "owner" }),
    ).toMatchObject({ outcome: "deleted" });
    expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual([]);
    expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
    // Pre-cutover messages remain readable; retirement only stops new generation.
    database.sqlite.exec(`INSERT INTO notifications
      (id,recipient_user_id,category,type,payload_json,dedupe_key,created_at)
      VALUES ('historical','owner','system','system.remove_request.resolved','{"kind":"image"}','historical','2026-08-02T12:00:00.000Z')`);
    const listed = await listNotifications(db, { userId: "owner", category: "system", limit: 20 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.type).toBe("system.remove_request.resolved");
  });

  it("sends an author approval without a community notification for a self-reply", async () => {
    database = createTestDatabase();
    insertUser(database.sqlite, { uid: "user-1" });
    const parent = comment("parent", "user-1", null, "2026-08-02T10:00:00.000Z", "Owner");
    const reply = comment("self-reply", "user-1", "parent", "2026-08-02T10:00:01.000Z", "Owner");
    persistSubmission(database, parent, "active");
    persistSubmission(database, reply, "pending_openai");
    expect((await reviewDecision(database, reply, reply.updatedAt)).outcome).toBe("committed");
    expect(
      (await listNotifications(database.db, { userId: "user-1", category: "community", limit: 20 }))
        .items,
    ).toEqual([]);
    expect(
      (await listNotifications(database.db, { userId: "user-1", category: "system", limit: 20 }))
        .items,
    ).toEqual([expect.objectContaining({ type: "system.submission.approved" })]);
    expect(await getNotificationUnreadCounts(database.db, "user-1")).toEqual({
      system: 1,
      community: 0,
      total: 1,
    });
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
