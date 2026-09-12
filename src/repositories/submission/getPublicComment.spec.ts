import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "../../test/sqliteD1";
import { getPublicCommentContextById } from "./getPublicComment";

let database: SqliteD1;
let db: D1Database;

beforeEach(() => {
  database = new SqliteD1();
  db = database.db;
  database.sqlite.exec(`
    CREATE TABLE users (
      uid TEXT PRIMARY KEY,
      uid_number INTEGER,
      uid_suffix TEXT,
      role TEXT,
      karma INTEGER,
      nickname TEXT,
      avt INTEGER
    );
    INSERT INTO users VALUES
      ('root-author', 1, 'AA', 'n', 3, 'Root author', 1),
      ('reply-author', 2, 'BB', 'n', 5, 'Reply author', 2);

    CREATE TABLE ugc_submissions (
      id TEXT PRIMARY KEY,
      poi_id TEXT NOT NULL,
      poi_hash TEXT NOT NULL,
      poi_type TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT,
      file_path TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      parent_id TEXT,
      comment_depth INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_ugc_visible_comment_parent
      ON ugc_submissions(parent_id, created_at, id)
      WHERE kind = 'comment'
        AND status IN ('active', 'flagged', 'remove_request');
    CREATE INDEX idx_ugc_comment_threads
      ON ugc_submissions(kind, poi_id, parent_id, status, created_at);

    CREATE TABLE ugc_submission_votes (
      submission_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      value INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (submission_id, user_id)
    );
    CREATE TABLE ugc_submission_flags (
      submission_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (submission_id, user_id)
    );
  `);
});

afterEach(() => database.sqlite.close());

function insertComment(payload: {
  id: string;
  parentId?: string | null;
  depth?: number;
  markerId?: string;
  kind?: "comment" | "image";
  status?: string;
  content?: string;
  userId?: string;
  createdAt?: string;
}) {
  database.sqlite.prepare(`
    INSERT INTO ugc_submissions (
      id, poi_id, poi_hash, poi_type, snapshot_id, user_id, content,
      file_path, kind, status, parent_id, comment_depth, created_at, updated_at
    ) VALUES (?, ?, 'hash', 'poi', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.id,
    payload.markerId ?? "marker-1",
    `snapshot-${payload.id}`,
    payload.userId ?? "reply-author",
    payload.content ?? `Content ${payload.id}`,
    payload.kind ?? "comment",
    payload.status ?? "active",
    payload.parentId ?? null,
    payload.depth ?? 0,
    payload.createdAt ?? "2026-09-10T00:00:00.000Z",
    payload.createdAt ?? "2026-09-10T00:00:00.000Z"
  );
}

describe("getPublicCommentContextById", () => {
  it("returns the public ancestor path from root to target", async () => {
    insertComment({
      id: "root",
      userId: "root-author",
      content: "Root context",
      createdAt: "2026-09-10T00:00:00.000Z"
    });
    insertComment({
      id: "parent",
      parentId: "root",
      depth: 1,
      status: "flagged",
      content: "Parent context",
      createdAt: "2026-09-10T00:01:00.000Z"
    });
    insertComment({
      id: "target",
      parentId: "parent",
      depth: 2,
      status: "remove_request",
      content: "Target context",
      createdAt: "2026-09-10T00:02:00.000Z"
    });
    database.sqlite.exec(`
      INSERT INTO ugc_submission_votes VALUES
        ('root', 'voter-1', 1, 1),
        ('root', 'voter-2', -1, 1),
        ('target', 'voter-1', 1, 1);
    `);

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.targetId).toBe("target");
    expect(context?.path.map((comment) => comment.id)).toEqual(["root", "parent", "target"]);
    expect(context?.path[0]).toMatchObject({
      content: "Root context",
      author: { nickname: "Root author", publicUid: "1AA", avatar: 1, karma: 3 },
      score: 0,
      replyCount: 1
    });
    expect(context?.path[2]).toMatchObject({
      parentId: "parent",
      depth: 2,
      content: "Target context",
      status: "remove_request",
      score: 1
    });
  });

  it("omits a non-public ancestor without exposing its content", async () => {
    insertComment({ id: "root", userId: "root-author", content: "Public root" });
    insertComment({
      id: "hidden-parent",
      parentId: "root",
      depth: 1,
      status: "stale",
      content: "Private removed content"
    });
    insertComment({
      id: "target",
      parentId: "hidden-parent",
      depth: 2,
      content: "Public target"
    });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.path.map((comment) => comment.id)).toEqual(["root", "target"]);
    expect(JSON.stringify(context)).not.toContain("Private removed content");
  });

  it("returns public descendants in parent-before-child order", async () => {
    insertComment({ id: "root" });
    insertComment({ id: "target", parentId: "root", depth: 1 });
    insertComment({
      id: "reply-later",
      parentId: "target",
      depth: 2,
      createdAt: "2026-09-10T00:02:00.000Z"
    });
    insertComment({
      id: "reply-earlier",
      parentId: "target",
      depth: 2,
      createdAt: "2026-09-10T00:01:00.000Z"
    });
    insertComment({
      id: "nested-reply",
      parentId: "reply-earlier",
      depth: 3,
      createdAt: "2026-09-10T00:00:00.000Z"
    });
    insertComment({ id: "root-sibling", parentId: "root", depth: 1 });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.replies.map((reply) => reply.id)).toEqual([
      "reply-earlier",
      "reply-later",
      "nested-reply"
    ]);
    expect(context?.replies[0]).toMatchObject({
      parentId: "target",
      depth: 2,
      replyCount: 1
    });
    expect(context?.repliesTruncated).toBe(false);

    const replyQuery = database.queries[1]!;
    expect(database.explain(replyQuery)).toContain("idx_ugc_comment_threads");
  });

  it("omits a non-public reply while retaining its public descendants", async () => {
    insertComment({ id: "target" });
    insertComment({
      id: "hidden-reply",
      parentId: "target",
      depth: 1,
      status: "pending_audit",
      content: "Private reply content"
    });
    insertComment({
      id: "public-grandchild",
      parentId: "hidden-reply",
      depth: 2,
      content: "Public descendant"
    });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.replies.map((reply) => reply.id)).toEqual(["public-grandchild"]);
    expect(JSON.stringify(context)).not.toContain("Private reply content");
  });

  it("stops ancestor and descendant traversal when parent links form a cycle", async () => {
    insertComment({ id: "target", parentId: "cycle-parent", depth: 2 });
    insertComment({ id: "cycle-parent", parentId: "target", depth: 1 });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.path.map((comment) => comment.id)).toEqual(["cycle-parent", "target"]);
    expect(context?.replies.map((comment) => comment.id)).toEqual(["cycle-parent"]);
  });

  it("bounds hidden descendant traversal and reports conservative truncation", async () => {
    insertComment({ id: "target" });
    for (let index = 0; index < 300; index += 1) {
      insertComment({
        id: `hidden-${String(index).padStart(3, "0")}`,
        parentId: "target",
        depth: 1,
        status: "pending_audit",
        content: `Private ${index}`
      });
    }

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.replies).toEqual([]);
    expect(context?.repliesTruncated).toBe(true);
    expect(JSON.stringify(context)).not.toContain("Private");
  });

  it.each([
    { ending: "public child", truncated: true },
    { ending: "hidden child", truncated: true },
    { ending: "leaf", truncated: false },
    { ending: "other marker", truncated: false },
    { ending: "image", truncated: false },
    { ending: "cycle", truncated: false }
  ])("reports depth-limit truncation correctly for a $ending", async ({ ending, truncated }) => {
    insertComment({ id: "target", parentId: ending === "cycle" ? "hidden-64" : null });
    for (let depth = 1; depth <= 64; depth += 1) {
      insertComment({
        id: `hidden-${depth}`,
        parentId: depth === 1 ? "target" : `hidden-${depth - 1}`,
        depth,
        status: "pending_audit"
      });
    }
    if (ending !== "leaf" && ending !== "cycle") {
      insertComment({
        id: "beyond-limit",
        parentId: "hidden-64",
        depth: 65,
        status: ending === "hidden child" ? "pending_audit" : "active",
        markerId: ending === "other marker" ? "marker-2" : "marker-1",
        kind: ending === "image" ? "image" : "comment"
      });
    }

    const context = await getPublicCommentContextById(db, { id: "target", markerId: "marker-1" });

    expect(context?.replies).toEqual([]);
    expect(context?.repliesTruncated).toBe(truncated);
  });

  it("limits reply context to ten public descendants and reports truncation", async () => {
    insertComment({ id: "target" });
    for (let index = 0; index < 11; index += 1) {
      insertComment({
        id: `reply-${String(index).padStart(2, "0")}`,
        parentId: "target",
        depth: 1,
        createdAt: `2026-09-10T00:${String(index).padStart(2, "0")}:00.000Z`
      });
    }

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.replies.map((reply) => reply.id)).toEqual([
      "reply-00",
      "reply-01",
      "reply-02",
      "reply-03",
      "reply-04",
      "reply-05",
      "reply-06",
      "reply-07",
      "reply-08",
      "reply-09"
    ]);
    expect(context?.repliesTruncated).toBe(true);
  });

  it.each(["pending_openai", "pending_audit", "stale"])(
    "does not return a target with non-public status %s",
    async (status) => {
      insertComment({ id: "target", status });

      await expect(getPublicCommentContextById(db, {
        id: "target",
        markerId: "marker-1"
      })).resolves.toBeNull();
    }
  );

  it("requires the exact target ID, marker, and comment kind", async () => {
    insertComment({ id: "target" });
    insertComment({ id: "image", kind: "image" });

    await expect(getPublicCommentContextById(db, {
      id: "missing",
      markerId: "marker-1"
    })).resolves.toBeNull();
    await expect(getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-2"
    })).resolves.toBeNull();
    await expect(getPublicCommentContextById(db, {
      id: "image",
      markerId: "marker-1"
    })).resolves.toBeNull();
  });
});
