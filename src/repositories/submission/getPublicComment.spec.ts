import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "@/test/database/createTestDatabase";
import type { SqliteD1 } from "@/test/database/sqliteD1";
import { insertSubmission, type SubmissionFixture } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

import { getPublicCommentContextById } from "./getPublicComment";

let database: SqliteD1;
let db: D1Database;

beforeEach(() => {
  database = createTestDatabase();
  db = database.db;
  insertUser(database.sqlite, {
    uid: "root-author",
    uid_number: 1,
    uid_suffix: "AA",
    karma: 3,
    nickname: "Root author",
    avt: 1,
  });
  insertUser(database.sqlite, {
    uid: "reply-author",
    uid_number: 2,
    uid_suffix: "BB",
    karma: 5,
    nickname: "Reply author",
    avt: 2,
  });
});

afterEach(() => database.close());

type CommentFixture = Omit<SubmissionFixture, "userId"> & { userId?: string };

function insertComment(payload: CommentFixture) {
  return insertSubmission(database.sqlite, {
    ...payload,
    userId: payload.userId ?? "reply-author",
  });
}

describe("getPublicCommentContextById", () => {
  it("returns the public ancestor path from root to target", async () => {
    insertComment({
      id: "root",
      userId: "root-author",
      content: "Root context",
      createdAt: "2026-09-10T00:00:00.000Z",
    });
    insertComment({
      id: "parent",
      parentId: "root",
      depth: 1,
      status: "flagged",
      content: "Parent context",
      createdAt: "2026-09-10T00:01:00.000Z",
    });
    insertComment({
      id: "target",
      parentId: "parent",
      depth: 2,
      status: "remove_request",
      content: "Target context",
      createdAt: "2026-09-10T00:02:00.000Z",
    });
    for (const uid of ["voter-1", "voter-2", "viewer"]) {
      insertUser(database.sqlite, { uid });
    }
    database.sqlite.exec(`
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active) VALUES
        ('root', 'voter-1', 1, 1),
        ('root', 'voter-2', -1, 1),
        ('target', 'voter-1', 1, 1);
    `);

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1",
    });

    expect(context?.targetId).toBe("target");
    expect(context?.path.map((comment) => comment.id)).toEqual(["root", "parent", "target"]);
    expect(context?.path[0]).toMatchObject({
      content: "Root context",
      author: { nickname: "Root author", publicUid: "1AA", avatar: 1, karma: 3 },
      score: 0,
      replyCount: 1,
    });
    expect(context?.path[2]).toMatchObject({
      parentId: "parent",
      depth: 2,
      content: "Target context",
      status: "remove_request",
      score: 1,
    });
    expect(context?.path[2]?.viewerVote).toBeUndefined();
    expect(context?.path[2]?.flagged).toBeUndefined();
  });

  it("includes viewer vote and flag state for linked context", async () => {
    insertComment({ id: "root", userId: "root-author" });
    insertComment({ id: "target", parentId: "root", depth: 1 });
    insertComment({ id: "reply", parentId: "target", depth: 2 });
    for (const uid of ["voter-1", "voter-2", "viewer"]) {
      insertUser(database.sqlite, { uid });
    }
    database.sqlite.exec(`
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active) VALUES
        ('target', 'viewer', 1, 1),
        ('reply', 'viewer', -1, 1);
      INSERT INTO ugc_submission_flags (submission_id, user_id, active) VALUES
        ('root', 'viewer', 1),
        ('reply', 'viewer', 1);
    `);

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1",
      viewerUserId: "viewer",
    });

    expect(context?.path[0]).toMatchObject({
      id: "root",
      viewerVote: 0,
      flagged: true,
    });
    expect(context?.path[1]).toMatchObject({
      id: "target",
      viewerVote: 1,
      flagged: false,
    });
    expect(context?.replies[0]).toMatchObject({
      id: "reply",
      viewerVote: -1,
      flagged: true,
    });
  });

  it("omits a non-public ancestor without exposing its content", async () => {
    insertComment({ id: "root", userId: "root-author", content: "Public root" });
    insertComment({
      id: "hidden-parent",
      parentId: "root",
      depth: 1,
      status: "stale",
      content: "Private removed content",
    });
    insertComment({
      id: "target",
      parentId: "hidden-parent",
      depth: 2,
      content: "Public target",
    });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1",
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
      createdAt: "2026-09-10T00:02:00.000Z",
    });
    insertComment({
      id: "reply-earlier",
      parentId: "target",
      depth: 2,
      createdAt: "2026-09-10T00:01:00.000Z",
    });
    insertComment({
      id: "nested-reply",
      parentId: "reply-earlier",
      depth: 3,
      createdAt: "2026-09-10T00:00:00.000Z",
    });
    insertComment({ id: "root-sibling", parentId: "root", depth: 1 });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1",
    });

    expect(context?.replies.map((reply) => reply.id)).toEqual([
      "reply-earlier",
      "reply-later",
      "nested-reply",
    ]);
    expect(context?.replies[0]).toMatchObject({
      parentId: "target",
      depth: 2,
      replyCount: 1,
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
      content: "Private reply content",
    });
    insertComment({
      id: "public-grandchild",
      parentId: "hidden-reply",
      depth: 2,
      content: "Public descendant",
    });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1",
    });

    expect(context?.replies.map((reply) => reply.id)).toEqual(["public-grandchild"]);
    expect(JSON.stringify(context)).not.toContain("Private reply content");
  });

  it("stops ancestor and descendant traversal when parent links form a cycle", async () => {
    insertComment({ id: "target", parentId: "cycle-parent", depth: 2 });
    insertComment({ id: "cycle-parent", parentId: "target", depth: 1 });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1",
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
        content: `Private ${index}`,
      });
    }

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1",
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
    { ending: "cycle", truncated: false },
  ])("reports depth-limit truncation correctly for a $ending", async ({ ending, truncated }) => {
    insertComment({ id: "target", parentId: ending === "cycle" ? "hidden-64" : null });
    for (let depth = 1; depth <= 64; depth += 1) {
      insertComment({
        id: `hidden-${depth}`,
        parentId: depth === 1 ? "target" : `hidden-${depth - 1}`,
        depth,
        status: "pending_audit",
      });
    }
    if (ending !== "leaf" && ending !== "cycle") {
      insertComment({
        id: "beyond-limit",
        parentId: "hidden-64",
        depth: 65,
        status: ending === "hidden child" ? "pending_audit" : "active",
        markerId: ending === "other marker" ? "marker-2" : "marker-1",
        kind: ending === "image" ? "image" : "comment",
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
        createdAt: `2026-09-10T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1",
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
      "reply-09",
    ]);
    expect(context?.repliesTruncated).toBe(true);
  });

  it.each(["pending_openai", "pending_audit", "stale"])(
    "does not return a target with non-public status %s",
    async (status) => {
      insertComment({ id: "target", status });

      await expect(
        getPublicCommentContextById(db, {
          id: "target",
          markerId: "marker-1",
        }),
      ).resolves.toBeNull();
    },
  );

  it("requires the exact target ID, marker, and comment kind", async () => {
    insertComment({ id: "target" });
    insertComment({ id: "image", kind: "image" });

    await expect(
      getPublicCommentContextById(db, {
        id: "missing",
        markerId: "marker-1",
      }),
    ).resolves.toBeNull();
    await expect(
      getPublicCommentContextById(db, {
        id: "target",
        markerId: "marker-2",
      }),
    ).resolves.toBeNull();
    await expect(
      getPublicCommentContextById(db, {
        id: "image",
        markerId: "marker-1",
      }),
    ).resolves.toBeNull();
  });
});
