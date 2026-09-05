import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../../types/app";
import type { PublicSubmissionComment } from "../../repositories/submission/types";
import { handleListPublicImages } from "./listPublicImages";
import { handleListPublicComments } from "./listPublicComments";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(), imagesCache: vi.fn(), commentsCache: vi.fn(),
  imageReactions: vi.fn(), commentState: vi.fn()
}));

vi.mock("../../middleware/auth", () => ({ resolveAuthIdentity: mocks.identity }));
vi.mock("../../middleware/cache/publicReadClient", () => ({
  fetchPublicImagesFromWorkersCache: mocks.imagesCache,
  fetchPublicCommentsFromWorkersCache: mocks.commentsCache
}));
vi.mock("../../repositories/submission/listImages", () => ({
  listImageViewerReactionsByMarker: mocks.imageReactions,
  listActiveImagesByMarker: vi.fn(), listUserImagesByMarker: vi.fn()
}));
vi.mock("../../repositories/submission/listComments", () => ({
  listCommentViewerStateByMarker: mocks.commentState,
  listActiveCommentsByMarker: vi.fn(), listUserCommentsByMarker: vi.fn()
}));

const env = { DB: {} } as Bindings;
const app = new Hono<AppEnv>();
app.get("/images", handleListPublicImages);
app.get("/comments", handleListPublicComments);

function comment(id: string, parentId: string | null, replies: PublicSubmissionComment[] = []): PublicSubmissionComment {
  return {
    id, parentId, markerId: "marker-1", replies, depth: parentId ? 1 : 0,
    createdAt: "2026-09-05", content: id, replyCount: replies.length,
    score: 0, viewerVote: 0, flagged: false, poiHash: "hash", poiType: "poi",
    editUndoAvailable: false, author: null, status: "active"
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.identity.mockResolvedValue({ uid: "viewer" });
  mocks.imageReactions.mockResolvedValue(new Map());
  mocks.commentState.mockResolvedValue({ pendingComments: [], reactions: new Map() });
});

describe("personalized UGC cache overlays", () => {
  it("only requests reactions for images returned by the public cache", async () => {
    mocks.imagesCache.mockResolvedValue(Response.json({ items: [{ id: "image-1", markerId: "marker-1" }] }));
    mocks.imageReactions.mockResolvedValue(new Map([["image-1", { upvoted: true, flagged: false }]]));
    const response = await app.request("/images?markerIds=marker-1,marker-2&scope=prod", {
      headers: { cookie: "session=test" }
    }, env);
    expect(mocks.imageReactions).toHaveBeenCalledWith(env.DB, {
      userId: "viewer", markerIds: ["marker-1", "marker-2"], submissionIds: ["image-1"],
      pathPrefix: undefined, excludePathPrefix: "_test"
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ items: [{ id: "image-1", upvoted: true }] });
  });

  it("includes returned nested replies in reaction lookups while preserving pending roots", async () => {
    const root = comment("root", null, [comment("reply", "root", [comment("nested", "reply")])]);
    mocks.commentsCache.mockResolvedValue(Response.json({ items: [root] }));
    mocks.commentState.mockResolvedValue({
      pendingComments: [{ ...comment("pending", null), status: "pending_audit" }],
      reactions: new Map([["nested", { viewerVote: -1, flagged: true }]])
    });
    const response = await app.request("/comments?markerId=marker-1", { headers: { cookie: "session=test" } }, env);
    expect(mocks.commentState).toHaveBeenCalledWith(env.DB, {
      userId: "viewer", markerIds: ["marker-1"], submissionIds: ["root", "reply", "nested"], pendingLimit: 200
    });
    const payload = await response.json() as { items: PublicSubmissionComment[] };
    expect(payload.items.map((item) => item.id)).toContain("pending");
    expect(payload.items.find((item) => item.id === "root")!.replies[0]!.replies[0])
      .toMatchObject({ id: "nested", viewerVote: -1, flagged: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(["images", "comments"])("keeps partial metadata for authenticated %s responses", async (kind) => {
    const cache = kind === "images" ? mocks.imagesCache : mocks.commentsCache;
    cache.mockResolvedValue(Response.json({ items: [], partial: true }, {
      headers: { "x-oem-partial-response": "true", "x-oem-failed-marker-count": "2" }
    }));
    const response = await app.request(`/${kind}?markerId=marker-1`, { headers: { cookie: "session=test" } }, env);
    expect(await response.json()).toEqual({ items: [], partial: true });
    expect(response.headers.get("x-oem-partial-response")).toBe("true");
    expect(response.headers.get("x-oem-failed-marker-count")).toBe("2");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const overlay = kind === "images" ? mocks.imageReactions : mocks.commentState;
    expect(overlay).toHaveBeenCalledWith(env.DB, expect.objectContaining({ submissionIds: [] }));
  });

  it.each(["images", "comments"])("does not read viewer state for anonymous or public-only %s", async (kind) => {
    const cache = kind === "images" ? mocks.imagesCache : mocks.commentsCache;
    cache.mockImplementation(async () => Response.json({ items: [] }, { headers: { "cache-control": "public, max-age=15" } }));
    for (const publicOnly of [false, true]) {
      const response = await app.request(`/${kind}?markerId=marker-1${publicOnly ? "&publicOnly=1" : ""}`, {
        headers: publicOnly ? { cookie: "session=test" } : {}
      }, env);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=15");
    }
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.imageReactions).not.toHaveBeenCalled();
    expect(mocks.commentState).not.toHaveBeenCalled();
  });
});
