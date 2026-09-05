import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
  type TransitionNotificationPayload
} from "./notifications";
import type { SubmissionRecord, SubmissionStatus } from "./submission/types";
import { transitionSubmissionStatusWithNotifications } from "./submission/statusSubmission";
import { createSubmissionUpvote } from "./submission/voteSubmission";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: SQLInputValue[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1Statement(
      this.database,
      this.query,
      values as SQLInputValue[]
    ) as unknown as D1PreparedStatement;
  }

  execute(): D1Result<Record<string, unknown>> {
    const statement = this.database.prepare(this.query);
    if (this.isReader(statement)) {
      return {
        success: true,
        results: statement.all(...this.values) as Record<string, unknown>[],
        meta: { changes: 0 } as D1Meta & Record<string, unknown>
      };
    }
    const result = statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) } as D1Meta & Record<string, unknown>
    };
  }

  async all<T>(): Promise<D1Result<T>> {
    return this.execute() as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values);
    return (row ?? null) as T | null;
  }

  async run<T>(): Promise<D1Result<T>> {
    return this.execute() as unknown as D1Result<T>;
  }

  private isReader(statement: StatementSync): boolean {
    return statement.columns().length > 0;
  }
}

class SqliteD1Database {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.sqlite, query) as unknown as D1PreparedStatement;
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => (
        (statement as unknown as SqliteD1Statement).execute() as unknown as D1Result<T>
      ));
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }
}

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
  updatedAt
});

const transition = (
  item: SubmissionRecord,
  transitionedAt: string,
  nextStatus: SubmissionStatus = "active",
  previousStatus: SubmissionStatus = "pending_openai"
): TransitionNotificationPayload => ({
  submission: item,
  previousStatus,
  nextStatus,
  source: "auto_moderation",
  transitionedAt
});

const comment = (
  id: string,
  userId: string,
  parentId: string | null,
  updatedAt: string,
  nickname: string
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
    avatar: 1
  }
});

describe("notification aggregation SQL", () => {
  let database: SqliteD1Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("counts one unread container, reopens it after read, and starts a new fixed window", async () => {
    database = new SqliteD1Database();
    const db = database as unknown as D1Database;
    database.sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (uid TEXT PRIMARY KEY);
      CREATE TABLE ugc_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        parent_id TEXT,
        poi_id TEXT NOT NULL,
        poi_hash TEXT NOT NULL,
        poi_type TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT
      );
      ${readFileSync(new URL("../../migrations/0029_notifications.sql", import.meta.url), "utf8")}
      ${readFileSync(new URL("../../migrations/0030_notification_aggregation.sql", import.meta.url), "utf8")}
      INSERT INTO users (uid) VALUES ('user-1');
    `);

    const write = async (id: string, createdAt: string) => {
      const item = submission(id, createdAt);
      database?.sqlite.prepare(
        `INSERT INTO ugc_submissions (
           id, user_id, poi_id, poi_hash, poi_type, snapshot_id, status, updated_at, kind
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'image')`
      ).run(
        item.id,
        item.userId,
        item.markerId,
        item.poiHash,
        item.poiType,
        item.snapshotId,
        createdAt
      );
      await db.batch(prepareSubmissionStatusNotificationWrite(db, transition(item, createdAt)));
    };

    await write("1", "2026-08-02T10:00:00.000Z");
    await db.batch(prepareSubmissionStatusNotificationWrite(
      db,
      transition(submission("1", "2026-08-02T10:00:00.000Z"), "2026-08-02T10:00:00.000Z")
    ));
    await write("2", "2026-08-02T10:00:30.000Z");

    let listed = await listNotifications(db, { userId: "user-1", category: "system", limit: 20 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.messages).toHaveLength(2);
    expect(serializeNotificationItem(listed.items[0]!).payload).toEqual({ kind: "image", messageCount: 2 });
    expect(await getNotificationUnreadCounts(db, "user-1")).toEqual({ system: 1, community: 0, total: 1 });

    await markNotificationRead(db, {
      userId: "user-1",
      category: "system",
      id: listed.items[0]!.id
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

    const firstPage = await listNotifications(db, { userId: "user-1", category: "system", limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listNotifications(db, {
      userId: "user-1",
      category: "system",
      limit: 1,
      cursor: decodeNotificationCursor(firstPage.nextCursor ?? undefined)
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
        "missing-notification"
      ]
    });
    expect(changed).toBe(2);
    expect(await getNotificationUnreadCounts(db, "user-1")).toEqual({
      system: 0,
      community: 0,
      total: 0
    });
  });

  it("writes all aggregation key variants and keeps unrelated reply and vote groups separate", async () => {
    database = new SqliteD1Database();
    const db = database as unknown as D1Database;
    database.sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (uid TEXT PRIMARY KEY);
      CREATE TABLE ugc_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        parent_id TEXT,
        poi_id TEXT NOT NULL,
        poi_hash TEXT NOT NULL,
        poi_type TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT
      );
      CREATE TABLE ugc_submission_votes (
        submission_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        value INTEGER NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (submission_id, user_id)
      );
      ${readFileSync(new URL("../../migrations/0029_notifications.sql", import.meta.url), "utf8")}
      ${readFileSync(new URL("../../migrations/0030_notification_aggregation.sql", import.meta.url), "utf8")}
      INSERT INTO users (uid) VALUES ('user-1'), ('user-2'), ('user-3');
    `);

    const insertSubmission = (item: SubmissionRecord, status: SubmissionStatus) => {
      database?.sqlite.prepare(
        `INSERT INTO ugc_submissions (
           id, user_id, parent_id, poi_id, poi_hash, poi_type,
           snapshot_id, status, updated_at, kind, content
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        item.id,
        item.userId,
        item.parentId,
        item.markerId,
        item.poiHash,
        item.poiType,
        item.snapshotId,
        status,
        item.updatedAt,
        item.kind,
        item.content
      );
    };

    const review = submission("review", "2026-08-02T11:00:00.000Z");
    const removed = submission("removed", "2026-08-02T11:00:01.000Z");
    const reopenedInitially = submission("reopened", "2026-08-02T11:00:02.000Z");
    insertSubmission(review, "pending_audit");
    insertSubmission(removed, "stale");
    insertSubmission(reopenedInitially, "active");
    await db.batch(prepareSubmissionStatusNotificationWrite(
      db,
      transition(review, review.updatedAt, "pending_audit")
    ));
    await db.batch(prepareSubmissionStatusNotificationWrite(
      db,
      transition(removed, removed.updatedAt, "stale", "remove_request")
    ));
    await db.batch(prepareSubmissionStatusNotificationWrite(
      db,
      transition(reopenedInitially, reopenedInitially.updatedAt)
    ));
    const reopenedResolved = {
      ...reopenedInitially,
      updatedAt: "2026-08-02T11:00:20.000Z"
    };
    database.sqlite.prepare(
      "UPDATE ugc_submissions SET updated_at = ? WHERE id = ?"
    ).run(reopenedResolved.updatedAt, reopenedResolved.id);
    await db.batch(prepareSubmissionStatusNotificationWrite(
      db,
      transition(reopenedResolved, reopenedResolved.updatedAt, "active", "remove_request")
    ));

    const parent1 = comment("parent-1", "user-1", null, "2026-08-02T11:01:00.000Z", "Owner");
    const parent2 = comment("parent-2", "user-1", null, "2026-08-02T11:01:00.000Z", "Owner");
    const reply1 = comment("reply-1", "user-2", parent1.id, "2026-08-02T11:01:01.000Z", "Alice");
    const reply2 = comment("reply-2", "user-3", parent1.id, "2026-08-02T11:01:20.000Z", "Bob");
    const reply3 = comment("reply-3", "user-2", parent2.id, "2026-08-02T11:01:21.000Z", "Alice");
    for (const item of [parent1, parent2, reply1, reply2, reply3]) insertSubmission(item, "active");
    for (const item of [reply1, reply2, reply3]) {
      await db.batch(prepareApprovedReplyNotificationWrite(db, transition(item, item.updatedAt)));
    }

    const voteTarget = comment("vote-target", "user-1", null, "2026-08-02T11:02:00.000Z", "Owner");
    insertSubmission(voteTarget, "active");
    const actors = [
      {
        uid: "user-2",
        publicUid: "public-user-2",
        nickname: "Alice",
        avatar: 1,
        email: "alice@example.com",
        role: "n" as const,
        karma: 0,
        needsProfileSetup: false
      },
      {
        uid: "user-3",
        publicUid: "public-user-3",
        nickname: "Bob",
        avatar: 2,
        email: "bob@example.com",
        role: "n" as const,
        karma: 0,
        needsProfileSetup: false
      }
    ];
    for (const [index, actor] of actors.entries()) {
      const changedAt = `2026-08-02T11:02:${String(index * 20).padStart(2, "0")}.000Z`;
      database.sqlite.prepare(
        `INSERT INTO ugc_submission_votes (
           submission_id, user_id, value, active, created_at, updated_at
         ) VALUES (?, ?, 1, 1, ?, ?)`
      ).run(voteTarget.id, actor.uid, changedAt, changedAt);
      await db.batch(prepareCommentVoteNotificationWrite(db, {
        submissionId: voteTarget.id,
        actor,
        value: 1,
        changedAt
      }));
    }

    const system = await listNotifications(db, { userId: "user-1", category: "system", limit: 20 });
    expect(system.items.map((item) => item.type).sort()).toEqual([
      "system.remove_request.resolved",
      "system.submission.approved",
      "system.submission.needs_review"
    ]);
    expect(system.items.find((item) => item.type === "system.remove_request.resolved")?.messages).toHaveLength(2);

    const community = await listNotifications(db, { userId: "user-1", category: "community", limit: 20 });
    expect(community.items).toHaveLength(3);
    const replyGroups = community.items.filter((item) => item.type === "community.comment.reply");
    const voteGroup = community.items.find((item) => item.type === "community.comment.vote");
    expect(replyGroups.map((item) => item.messages.length).sort()).toEqual([1, 2]);
    expect(voteGroup?.messages).toHaveLength(2);
    expect(voteGroup && serializeNotificationItem(voteGroup).payload).toEqual({
      kind: "comment",
      messageCount: 2
    });
    expect(await getNotificationUnreadCounts(db, "user-1")).toEqual({ system: 3, community: 3, total: 6 });
  });

  it("aggregates likes for six hours per target while replies keep the one-minute window", async () => {
    database = new SqliteD1Database();
    const db = database as unknown as D1Database;
    database.sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (uid TEXT PRIMARY KEY);
      CREATE TABLE ugc_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        parent_id TEXT,
        poi_id TEXT NOT NULL,
        poi_hash TEXT NOT NULL,
        poi_type TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT
      );
      CREATE TABLE ugc_submission_votes (
        submission_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        value INTEGER NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (submission_id, user_id)
      );
      ${readFileSync(new URL("../../migrations/0029_notifications.sql", import.meta.url), "utf8")}
      ${readFileSync(new URL("../../migrations/0030_notification_aggregation.sql", import.meta.url), "utf8")}
      INSERT INTO users (uid) VALUES ('owner'), ('actor-1'), ('actor-2'), ('actor-3'), ('actor-4');
    `);

    const insertComment = (item: SubmissionRecord) => {
      database?.sqlite.prepare(
        `INSERT INTO ugc_submissions (
           id, user_id, parent_id, poi_id, poi_hash, poi_type,
           snapshot_id, status, updated_at, kind, content
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 'comment', ?)`
      ).run(
        item.id,
        item.userId,
        item.parentId,
        item.markerId,
        item.poiHash,
        item.poiType,
        item.snapshotId,
        item.updatedAt,
        item.content
      );
    };
    const actor = (uid: string) => ({
      uid,
      publicUid: `public-${uid}`,
      nickname: uid,
      avatar: 1,
      email: `${uid}@example.com`,
      role: "n" as const,
      karma: 0,
      needsProfileSetup: false
    });
    const addVote = async (targetId: string, uid: string, changedAt: string) => {
      database?.sqlite.prepare(
        `INSERT INTO ugc_submission_votes (
           submission_id, user_id, value, active, created_at, updated_at
         ) VALUES (?, ?, 1, 1, ?, ?)`
      ).run(targetId, uid, changedAt, changedAt);
      await db.batch(prepareCommentVoteNotificationWrite(db, {
        submissionId: targetId,
        actor: actor(uid),
        value: 1,
        changedAt
      }));
    };

    const voteTarget1 = comment("vote-target-1", "owner", null, "2026-08-02T00:00:00.000Z", "Owner");
    const voteTarget2 = comment("vote-target-2", "owner", null, "2026-08-02T00:00:00.000Z", "Owner");
    insertComment(voteTarget1);
    insertComment(voteTarget2);
    await addVote(voteTarget1.id, "actor-1", "2026-08-02T00:00:00.000Z");
    await addVote(voteTarget1.id, "actor-2", "2026-08-02T05:59:59.999Z");
    await addVote(voteTarget1.id, "actor-3", "2026-08-02T06:00:00.000Z");
    await addVote(voteTarget2.id, "actor-4", "2026-08-02T01:00:00.000Z");

    const parent = comment("reply-parent", "owner", null, "2026-08-02T10:00:00.000Z", "Owner");
    const reply1 = comment("reply-1m", "actor-1", parent.id, "2026-08-02T10:00:00.000Z", "Actor 1");
    const reply2 = comment("reply-2m", "actor-2", parent.id, "2026-08-02T10:01:00.000Z", "Actor 2");
    insertComment(parent);
    insertComment(reply1);
    insertComment(reply2);
    await db.batch(prepareApprovedReplyNotificationWrite(db, transition(reply1, reply1.updatedAt)));
    await db.batch(prepareApprovedReplyNotificationWrite(db, transition(reply2, reply2.updatedAt)));

    const listed = await listNotifications(db, { userId: "owner", category: "community", limit: 20 });
    const voteGroups = listed.items.filter((item) => item.type === "community.comment.vote");
    const replyGroups = listed.items.filter((item) => item.type === "community.comment.reply");
    expect(voteGroups).toHaveLength(3);
    expect(voteGroups.map((item) => item.messages.length).sort()).toEqual([1, 1, 2]);
    expect(replyGroups).toHaveLength(2);
    expect(replyGroups.map((item) => item.messages.length)).toEqual([1, 1]);
  });

  it("returns a notification for a persisted user recall", async () => {
    database = new SqliteD1Database();
    const db = database as unknown as D1Database;
    database.sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (uid TEXT PRIMARY KEY);
      CREATE TABLE ugc_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        parent_id TEXT,
        poi_id TEXT NOT NULL,
        poi_hash TEXT NOT NULL,
        poi_type TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT,
        moderation_note TEXT,
        edit_original_content TEXT,
        edit_original_status TEXT,
        edit_original_snapshot_id TEXT
      );
      ${readFileSync(new URL("../../migrations/0029_notifications.sql", import.meta.url), "utf8")}
      ${readFileSync(new URL("../../migrations/0030_notification_aggregation.sql", import.meta.url), "utf8")}
      INSERT INTO users (uid) VALUES ('owner');
      INSERT INTO ugc_submissions (
        id, user_id, poi_id, poi_hash, poi_type, snapshot_id,
        status, updated_at, kind, moderation_note
      ) VALUES (
        'remove-1', 'owner', 'marker-1', 'hash-1', 'type-1', 'snapshot-1',
        'active', '2026-08-02T12:00:00.000Z', 'image', NULL
      );
    `);

    const current = {
      ...submission("remove-1", "2026-08-02T12:00:00.000Z"),
      userId: "owner",
      snapshotId: "snapshot-1",
      status: "active" as const,
      moderationNote: null
    };
    const result = await transitionSubmissionStatusWithNotifications(db, {
      submission: current,
      status: "stale",
      moderationNote: "Recalled by uploader.",
      source: "user_action"
    });

    expect(result.updated).toBe(true);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.type).toBe("system.remove_request.resolved");
    const listed = await listNotifications(db, { userId: "owner", category: "system", limit: 20 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.type).toBe("system.remove_request.resolved");
  });

  it("notifies image owners for a new upvote, ignores duplicates, and suppresses self-upvotes", async () => {
    database = new SqliteD1Database();
    const db = database as unknown as D1Database;
    database.sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (uid TEXT PRIMARY KEY);
      CREATE TABLE ugc_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        parent_id TEXT,
        poi_id TEXT NOT NULL,
        poi_hash TEXT NOT NULL,
        poi_type TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT
      );
      CREATE TABLE ugc_submission_upvotes (
        submission_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (submission_id, user_id)
      );
      ${readFileSync(new URL("../../migrations/0029_notifications.sql", import.meta.url), "utf8")}
      ${readFileSync(new URL("../../migrations/0030_notification_aggregation.sql", import.meta.url), "utf8")}
      INSERT INTO users (uid) VALUES ('owner'), ('actor');
      INSERT INTO ugc_submissions (
        id, user_id, poi_id, poi_hash, poi_type, snapshot_id,
        status, updated_at, kind, content
      ) VALUES
        ('image-1', 'owner', 'marker-1', 'hash-1', 'type-1', 'snapshot-1',
         'active', '2026-08-02T12:00:00.000Z', 'image', NULL),
        ('image-self', 'actor', 'marker-2', 'hash-2', 'type-1', 'snapshot-2',
         'active', '2026-08-02T12:00:00.000Z', 'image', NULL);
    `);

    const actor = {
      uid: "actor",
      publicUid: "public-actor",
      nickname: "Actor",
      avatar: 1,
      email: "actor@example.com",
      role: "n" as const,
      karma: 0,
      needsProfileSetup: false
    };
    const first = await createSubmissionUpvote(db, { submissionId: "image-1", actor });
    const duplicate = await createSubmissionUpvote(db, { submissionId: "image-1", actor });
    const self = await createSubmissionUpvote(db, { submissionId: "image-self", actor });

    expect(first.created).toBe(true);
    expect(first.notifications).toHaveLength(1);
    expect(duplicate.created).toBe(false);
    expect(duplicate.notifications).toHaveLength(0);
    expect(self.created).toBe(true);
    expect(self.notifications).toHaveLength(0);

    const listed = await listNotifications(db, { userId: "owner", category: "community", limit: 20 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.type).toBe("community.comment.vote");
    expect(listed.items[0] && serializeNotificationItem(listed.items[0]).payload).toEqual({ kind: "image" });
    expect(await getNotificationUnreadCounts(db, "owner")).toEqual({ system: 0, community: 1, total: 1 });
  });

  it("removes legacy rejected notifications and lets the delete trigger repair unread counters", async () => {
    database = new SqliteD1Database();
    database.sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (uid TEXT PRIMARY KEY);
      CREATE TABLE ugc_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        parent_id TEXT,
        poi_id TEXT NOT NULL,
        poi_hash TEXT NOT NULL,
        poi_type TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT
      );
      ${readFileSync(new URL("../../migrations/0029_notifications.sql", import.meta.url), "utf8")}
      INSERT INTO users (uid) VALUES ('user-1');
      INSERT INTO notifications (
        id, recipient_user_id, category, type, payload_json, dedupe_key, created_at
      ) VALUES
        ('legacy-rejected', 'user-1', 'system', 'system.submission.rejected', '{}', 'legacy-rejected', '2026-08-02T10:00:00.000Z'),
        ('legacy-approved', 'user-1', 'system', 'system.submission.approved', '{"kind":"image"}', 'legacy-approved', '2026-08-02T10:00:01.000Z');
    `);

    expect(database.sqlite.prepare(
      "SELECT system_unread FROM notification_counters WHERE user_id = 'user-1'"
    ).get()).toEqual({ system_unread: 2 });

    database.sqlite.exec(
      readFileSync(new URL("../../migrations/0030_notification_aggregation.sql", import.meta.url), "utf8")
    );

    expect(database.sqlite.prepare(
      "SELECT id FROM notifications ORDER BY id"
    ).all()).toEqual([{ id: "legacy-approved" }]);
    expect(database.sqlite.prepare(
      "SELECT system_unread FROM notification_counters WHERE user_id = 'user-1'"
    ).get()).toEqual({ system_unread: 1 });
  });
});
