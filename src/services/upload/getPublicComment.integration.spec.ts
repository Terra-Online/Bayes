import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onAppError } from "../../middleware/error-handler";
import { SqliteD1 } from "../../test/sqliteD1";
import type { AppEnv } from "../../types/app";
import { handleGetPublicComment } from "./getPublicComment";

let database: SqliteD1;

beforeEach(() => {
  database = new SqliteD1();
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

function request(path: string) {
  const app = new Hono<AppEnv>();
  app.onError(onAppError);
  app.get("/comments/:id", handleGetPublicComment);
  return app.request(
    `https://api.example.com${path}`,
    undefined,
    { DB: database.db } as AppEnv["Bindings"]
  );
}

type CommentFixture = Parameters<typeof insertComment>[0];

const unavailableCases: Array<{
  name: string;
  path: string;
  fixture: CommentFixture | null;
}> = [
  {
    name: "missing target",
    path: "/comments/missing?markerId=marker-1",
    fixture: null
  },
  {
    name: "wrong marker",
    path: "/comments/target?markerId=marker-2",
    fixture: { id: "target", content: "Wrong marker secret" }
  },
  {
    name: "image kind",
    path: "/comments/image?markerId=marker-1",
    fixture: { id: "image", kind: "image", content: "Image secret" }
  },
  ...["pending_openai", "pending_audit", "stale"].map((status) => ({
    name: `${status} target`,
    path: `/comments/${status}?markerId=marker-1`,
    fixture: {
      id: status,
      status,
      content: `Private ${status} content`
    }
  }))
];

describe("handleGetPublicComment integration", () => {
  it("returns public context through HTTP without exposing a hidden reply", async () => {
    insertComment({ id: "root", userId: "root-author", content: "Public root" });
    insertComment({ id: "target", parentId: "root", depth: 1, content: "Public target" });
    insertComment({
      id: "hidden-reply",
      parentId: "target",
      depth: 2,
      status: "pending_audit",
      content: "Private reply content"
    });
    insertComment({
      id: "public-grandchild",
      parentId: "hidden-reply",
      depth: 3,
      content: "Public descendant"
    });

    const response = await request("/comments/target?markerId=marker-1");
    const payload = await response.json() as {
      item: {
        path: Array<{ id: string }>;
        replies: Array<{ id: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(payload.item.path.map((comment) => comment.id)).toEqual(["root", "target"]);
    expect(payload.item.replies.map((comment) => comment.id)).toEqual(["public-grandchild"]);
    expect(JSON.stringify(payload)).not.toContain("Private reply content");
  });

  it.each(unavailableCases)("returns an indistinguishable 404 for $name", async ({ path, fixture }) => {
    if (fixture) insertComment(fixture);

    const response = await request(path);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(JSON.parse(body)).toEqual({
      code: "COMMENT_NOT_FOUND",
      message: "Comment not found.",
      error: {
        code: "COMMENT_NOT_FOUND",
        message: "Comment not found."
      }
    });
    if (fixture) {
      expect(body).not.toContain(fixture.content);
      if (fixture.status) expect(body).not.toContain(fixture.status);
    }
  });
});
