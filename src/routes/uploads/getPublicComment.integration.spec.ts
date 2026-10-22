import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { createTestDatabase } from "@/test/database/createTestDatabase";
import type { SqliteD1 } from "@/test/database/sqliteD1";
import { insertSubmission, type SubmissionFixture } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: SqliteD1;

beforeEach(() => {
  database = createTestDatabase();
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

function request(path: string) {
  const app = createRoutes();
  app.onError(onAppError);
  return app.request(`https://api.example.com${path}`, undefined, {
    DB: database.db,
  } as AppEnv["Bindings"]);
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
  ...["pending_openai", "pending_audit", "stale"].map((status) => ({
    name: `${status} target`,
    path: `/comments/${status}?markerId=marker-1`,
    fixture: {
      id: status,
      status,
      content: `Private ${status} content`,
    },
  })),
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
      content: "Private reply content",
    });
    insertComment({
      id: "public-grandchild",
      parentId: "hidden-reply",
      depth: 3,
      content: "Public descendant",
    });

    const response = await request("/comments/target?markerId=marker-1");
    const payload = (await response.json()) as {
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

  it.each(unavailableCases)(
    "returns an indistinguishable 404 for $name",
    async ({ path, fixture }) => {
      if (fixture) {
        insertComment(fixture);
      }

      const response = await request(path);
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(JSON.parse(body)).toEqual({
        code: "COMMENT_NOT_FOUND",
        message: "Comment not found.",
        error: {
          code: "COMMENT_NOT_FOUND",
          message: "Comment not found.",
        },
      });
      if (fixture) {
        expect(body).not.toContain(fixture.content);
        if (fixture.status) {
          expect(body).not.toContain(fixture.status);
        }
      }
    },
  );
});

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("@/middleware/rate-limit", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
