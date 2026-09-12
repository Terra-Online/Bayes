import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/errors";
import type { PublicCommentContext } from "../../repositories/submission/getPublicComment";
import type { PublicSubmissionComment } from "../../repositories/submission/types";
import type { AppEnv } from "../../types/app";

const mocks = vi.hoisted(() => ({
  getPublicCommentContextById: vi.fn()
}));

vi.mock("../../repositories/submission/getPublicComment", () => ({
  getPublicCommentContextById: mocks.getPublicCommentContextById
}));

import { handleGetPublicComment } from "./getPublicComment";

const target: PublicSubmissionComment = {
  id: "target",
  markerId: "42",
  poiHash: "hash",
  poiType: "poi",
  parentId: null,
  depth: 0,
  content: "Target comment",
  editUndoAvailable: false,
  author: null,
  status: "active",
  score: 2,
  replyCount: 0,
  replies: [],
  createdAt: "2026-09-10T00:00:00.000Z"
};

const context: PublicCommentContext = {
  targetId: "target",
  path: [target],
  replies: [],
  repliesTruncated: false
};

beforeEach(() => {
  vi.resetAllMocks();
});

function request(path: string) {
  const app = new Hono<AppEnv>();
  app.onError((error) => {
    if (error instanceof ApiError) {
      return new Response(JSON.stringify({ code: error.code }), { status: error.status });
    }
    throw error;
  });
  app.get("/comments/:id", handleGetPublicComment);
  return app.request(
    "https://api.example.com" + path,
    undefined,
    { DB: {} as D1Database } as AppEnv["Bindings"]
  );
}

describe("handleGetPublicComment", () => {
  it("returns public comment context with a private no-store response", async () => {
    mocks.getPublicCommentContextById.mockResolvedValue(context);

    const response = await request("/comments/target?markerId=42");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ item: context });
    expect(mocks.getPublicCommentContextById).toHaveBeenCalledWith(
      expect.anything(),
      { id: "target", markerId: "42" }
    );
  });

  it("returns the same comment not-found error for every unavailable target", async () => {
    mocks.getPublicCommentContextById.mockResolvedValue(null);

    const response = await request("/comments/unavailable?markerId=42");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "COMMENT_NOT_FOUND" });
  });

  it.each([
    "/comments/target",
    "/comments/target?markerId=",
    "/comments/target?markerId=" + "x".repeat(129)
  ])("rejects an invalid markerId in %s", async (path) => {
    const response = await request(path);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: "VALIDATION_ERROR" });
    expect(mocks.getPublicCommentContextById).not.toHaveBeenCalled();
  });
});
