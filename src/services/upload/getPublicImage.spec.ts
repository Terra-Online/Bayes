import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/errors";
import type { PublicSubmissionImage } from "@/repositories/submission/types";
import type { AppEnv } from "@/types/app";

const mocks = vi.hoisted(() => ({
  getPublicImageById: vi.fn(),
  getOptionalAuthIdentity: vi.fn(),
}));

vi.mock("@/repositories/submission/getPublicImage", () => ({
  getPublicImageById: mocks.getPublicImageById,
}));
vi.mock("./helpers", () => ({
  getOptionalAuthIdentity: mocks.getOptionalAuthIdentity,
}));

import { handleGetPublicImage } from "./getPublicImage";

const item: PublicSubmissionImage = {
  id: "photo",
  markerId: "42",
  url: "https://assets.example.com/images/photo.webp",
  content: "Caption",
  author: null,
  status: "active",
  upvoteCount: 2,
  flagCount: 1,
  createdAt: "2026-09-01",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getOptionalAuthIdentity.mockResolvedValue(null);
});

function request(path: string, headers?: Record<string, string>) {
  const app = new Hono<AppEnv>();
  app.onError((error) => {
    if (error instanceof ApiError) {
      return new Response(JSON.stringify({ code: error.code }), { status: error.status });
    }
    throw error;
  });
  app.get("/images/:id", handleGetPublicImage);
  return app.request("https://api.example.com" + path, { headers }, {
    DB: {} as D1Database,
    UGC_ASSET_BASE_URL: "https://assets.example.com",
    BETTER_AUTH_URL: "https://api.example.com",
    UGC_UPLOAD_TEST_PREFIX: "",
  } as AppEnv["Bindings"]);
}

describe("handleGetPublicImage", () => {
  it("returns the selected item with a private no-store response", async () => {
    mocks.getPublicImageById.mockResolvedValue(item);

    const response = await request("/images/photo?markerId=42");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ item });
    expect(mocks.getPublicImageById).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "photo",
        markerId: "42",
        assetBaseUrl: "https://assets.example.com",
      }),
    );
  });

  it("passes the production scope and viewer identity to the repository", async () => {
    mocks.getPublicImageById.mockResolvedValue(item);
    mocks.getOptionalAuthIdentity.mockResolvedValue({ uid: "viewer" });

    const response = await request("/images/photo?markerId=42&scope=prod", {
      authorization: "Bearer viewer",
    });

    expect(response.status).toBe(200);
    expect(mocks.getPublicImageById).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: "photo",
        markerId: "42",
        excludePathPrefix: "_test",
        viewerUserId: "viewer",
      }),
    );
  });

  it("returns not found when the repository has no matching image", async () => {
    mocks.getPublicImageById.mockResolvedValue(null);

    const response = await request("/images/missing?markerId=42");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND" });
  });

  it.each([
    "/images/photo",
    "/images/photo?markerId=",
    "/images/photo?markerId=" + "x".repeat(129),
  ])("rejects an invalid markerId in %s", async (path) => {
    const response = await request(path);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: "VALIDATION_ERROR" });
    expect(mocks.getPublicImageById).not.toHaveBeenCalled();
  });

  it("rejects an unknown scope before querying", async () => {
    const response = await request("/images/photo?markerId=42&scope=invalid");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: "VALIDATION_ERROR" });
    expect(mocks.getPublicImageById).not.toHaveBeenCalled();
  });
});
