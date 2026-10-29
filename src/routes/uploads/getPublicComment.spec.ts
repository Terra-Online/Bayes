import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { runWithAuthRequest } from "@/lib/auth/createAuth";
import type { PublicCommentContext } from "@/repositories/submission/getPublicComment";
import type { SnapshotReviewStatus } from "@/repositories/submission/snapshotReads";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession } from "@/test/fixtures/auth";
import type { SubmissionFixture } from "@/test/fixtures/submissions";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

let database: TestDatabase;
let mocks: MockBindings;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  database = createTestDatabase();
  importCurrentSubmissions(database);
  mocks = createMockBindings({ DB: database.db });
  app = createApp();
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

type CommentFixture = Omit<SubmissionFixture, "userId" | "status"> & {
  userId?: string;
  reviewStatus?: SnapshotReviewStatus;
};

function insertComment(payload: CommentFixture): void {
  const kind = payload.kind ?? "comment";
  const userId = payload.userId ?? "reply-author";
  database.sqlite
    .prepare(`INSERT INTO ugc_submissions
    (id,kind,poi_id,poi_hash,poi_type,user_id,parent_id,comment_depth,created_at)
    VALUES (?,?,?,'hash','poi',?,?,?,?)`)
    .run(
      payload.id,
      kind,
      payload.markerId ?? "marker-1",
      userId,
      payload.parentId ?? null,
      payload.depth ?? 0,
      payload.createdAt ?? "2026-09-10T00:00:00.000Z",
    );
  database.sqlite
    .prepare(`INSERT INTO ugc_snapshots
    (id,submission_id,kind,revision,content,file_path,review_status,creator_user_id)
    VALUES (?,?,?,1,?,?,?,?)`)
    .run(
      `snapshot-${payload.id}`,
      payload.id,
      kind,
      payload.content ?? `Content ${payload.id}`,
      kind === "image" ? "prod/image.webp" : null,
      payload.reviewStatus ?? "approved",
      userId,
    );
}

function request(path: string, headers?: HeadersInit) {
  return runWithAuthRequest(() =>
    app.request(`https://api.example.com/uploads/v1${path}`, { headers }, mocks.bindings),
  );
}

/** Every successful context must satisfy the same public HTTP contract. */
async function requestContext(id: string, headers?: HeadersInit): Promise<PublicCommentContext> {
  const response = await request(`/comments/${encodeURIComponent(id)}?markerId=marker-1`, headers);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const payload = (await response.json()) as { item: PublicCommentContext };
  return payload.item;
}

const unavailableCases: Array<{
  name: string;
  path: string;
  fixture: CommentFixture | null;
}> = [
  {
    name: "missing target",
    path: "/comments/missing?markerId=marker-1",
    fixture: null,
  },
  {
    name: "wrong marker",
    path: "/comments/target?markerId=marker-2",
    fixture: { id: "target", content: "Wrong marker secret" },
  },
  {
    name: "image kind",
    path: "/comments/image?markerId=marker-1",
    fixture: { id: "image", kind: "image", content: "Image secret" },
  },
  ...(["pending_openai", "pending_audit", "unknown"] as const).map((reviewStatus) => ({
    name: `${reviewStatus} target`,
    path: `/comments/${reviewStatus}?markerId=marker-1`,
    fixture: {
      id: reviewStatus,
      reviewStatus,
      content: `Private ${reviewStatus} content`,
    },
  })),
];

describe("public comment context through HTTP", () => {
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
      content: "Parent context",
      createdAt: "2026-09-10T00:01:00.000Z",
    });
    insertComment({
      id: "target",
      parentId: "parent",
      depth: 2,
      content: "Target context",
      createdAt: "2026-09-10T00:02:00.000Z",
    });
    for (const uid of ["voter-1", "voter-2", "viewer"]) {
      insertUser(database.sqlite, { uid });
    }
    database.sqlite.exec(`
      INSERT INTO ugc_submission_flags (submission_id,user_id) VALUES ('parent','root-author');
      INSERT INTO ugc_submission_votes (submission_id, user_id, value, active) VALUES
        ('root', 'voter-1', 1, 1),
        ('root', 'voter-2', -1, 1),
        ('target', 'voter-1', 1, 1);
    `);

    const context = await requestContext("target");

    expect(context.targetId).toBe("target");
    expect(context.path.map((comment) => comment.id)).toEqual(["root", "parent", "target"]);
    expect(context.path[0]).toMatchObject({
      content: "Root context",
      author: { nickname: "Root author", publicUid: "1AA", avatar: 1, karma: 3 },
      score: 0,
      replyCount: 1,
    });
    expect(context.path[1]).toMatchObject({ status: "flagged" });
    expect(context.path[2]).toMatchObject({
      parentId: "parent",
      depth: 2,
      content: "Target context",
      snapshotId: "snapshot-target",
      status: "active",
      score: 1,
    });
    expect(context.path[2]?.viewerVote).toBeUndefined();
    expect(context.path[2]?.flagged).toBeUndefined();
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

    insertAuthUser(database.sqlite, { id: "viewer" });
    const viewer = insertSession(database.sqlite, { userId: "viewer" });
    const context = await requestContext("target", viewer.headers);

    expect(context.path[0]).toMatchObject({
      id: "root",
      viewerVote: 0,
      flagged: true,
    });
    expect(context.path[1]).toMatchObject({
      id: "target",
      viewerVote: 1,
      flagged: false,
    });
    expect(context.replies[0]).toMatchObject({
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
      reviewStatus: "unknown",
      content: "Private removed content",
    });
    insertComment({
      id: "target",
      parentId: "hidden-parent",
      depth: 2,
      content: "Public target",
    });

    const context = await requestContext("target");

    expect(context.path.map((comment) => comment.id)).toEqual(["root", "target"]);
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

    const context = await requestContext("target");

    expect(context.replies.map((reply) => reply.id)).toEqual([
      "reply-earlier",
      "reply-later",
      "nested-reply",
    ]);
    expect(context.replies[0]).toMatchObject({
      parentId: "target",
      depth: 2,
      replyCount: 1,
    });
    expect(context.repliesTruncated).toBe(false);
  });

  it("stops ancestor and descendant traversal when parent links form a cycle", async () => {
    insertComment({ id: "target", parentId: "cycle-parent", depth: 2 });
    insertComment({ id: "cycle-parent", parentId: "target", depth: 1 });

    const context = await requestContext("target");

    expect(context.path.map((comment) => comment.id)).toEqual(["cycle-parent", "target"]);
    expect(context.replies.map((comment) => comment.id)).toEqual(["cycle-parent"]);
  });

  it("bounds hidden descendant traversal and reports conservative truncation", async () => {
    insertComment({ id: "target" });
    for (let index = 0; index < 300; index += 1) {
      insertComment({
        id: `hidden-${String(index).padStart(3, "0")}`,
        parentId: "target",
        depth: 1,
        reviewStatus: "pending_audit",
        content: `Private ${index}`,
      });
    }

    const context = await requestContext("target");

    expect(context.replies).toEqual([]);
    expect(context.repliesTruncated).toBe(true);
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
        reviewStatus: "pending_audit",
      });
    }
    if (ending !== "leaf" && ending !== "cycle") {
      insertComment({
        id: "beyond-limit",
        parentId: "hidden-64",
        depth: 65,
        reviewStatus: ending === "hidden child" ? "pending_audit" : "approved",
        markerId: ending === "other marker" ? "marker-2" : "marker-1",
        kind: ending === "image" ? "image" : "comment",
      });
    }

    const context = await requestContext("target");

    expect(context.replies).toEqual([]);
    expect(context.repliesTruncated).toBe(truncated);
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

    const context = await requestContext("target");

    expect(context.replies.map((reply) => reply.id)).toEqual([
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
    expect(context.repliesTruncated).toBe(true);
  });

  it("returns public context through HTTP without exposing a hidden reply", async () => {
    insertComment({ id: "root", userId: "root-author", content: "Public root" });
    insertComment({ id: "target", parentId: "root", depth: 1, content: "Public target" });
    insertComment({
      id: "hidden-reply",
      parentId: "target",
      depth: 2,
      reviewStatus: "pending_audit",
      content: "Private reply content",
    });
    insertComment({
      id: "public-grandchild",
      parentId: "hidden-reply",
      depth: 3,
      content: "Public descendant",
    });

    const context = await requestContext("target");

    expect(context.path.map((comment) => comment.id)).toEqual(["root", "target"]);
    expect(context.replies.map((comment) => comment.id)).toEqual(["public-grandchild"]);
    expect(JSON.stringify(context)).not.toContain("Private reply content");
  });

  it.each(unavailableCases)(
    "returns an indistinguishable 404 for $name",
    async ({ path, fixture }) => {
      if (fixture) {
        insertComment(fixture);
      }

      const response = await request(path, { "x-request-id": "comment-context-not-found" });
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(JSON.parse(body)).toEqual({
        code: "COMMENT_NOT_FOUND",
        message: "Comment not found.",
        requestId: "comment-context-not-found",
        error: {
          code: "COMMENT_NOT_FOUND",
          message: "Comment not found.",
          requestId: "comment-context-not-found",
        },
      });
      if (fixture) {
        expect(body).not.toContain(fixture.content);
        if (fixture.reviewStatus) {
          expect(body).not.toContain(fixture.reviewStatus);
        }
      }
    },
  );
});
