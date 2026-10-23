import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicSubmissionImage } from "@/repositories/submission/types";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(request: Request, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("cloudflare:workers", () => ({
  exports: {
    PublicReadCache: {
      fetch: mocks.fetch,
    },
  },
}));

import { publicReadResponse, readPublicImagesFromWorkersCache } from "./client";

describe("public image cache responses", () => {
  const image: PublicSubmissionImage = {
    id: "image",
    markerId: "marker",
    url: "https://assets.example/image.webp",
    content: "Visible image",
    author: null,
    status: "active",
    upvoteCount: 0,
    flagCount: 0,
    createdAt: "2026-09-10T00:00:00.000Z",
  };

  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockRejectedValue(new Error("Unconfigured public cache fetch"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects a malformed successful cache reply and allows a later read to succeed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.fetch
      .mockResolvedValueOnce(Response.json({ items: {} }))
      .mockResolvedValueOnce(Response.json({ items: [image] }));
    const payload = {
      markerIds: ["marker"],
      limit: 6,
      cacheNamespace: "prod" as const,
      assetBaseUrl: "https://assets.example",
    };
    const failed = publicReadResponse(await readPublicImagesFromWorkersCache(payload));
    expect(failed.status).toBe(502);
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
    expect(await failed.json()).toEqual({
      code: "PUBLIC_CACHE_READ_FAILED",
      message: "Public cache reads failed.",
    });

    const recovered = publicReadResponse(await readPublicImagesFromWorkersCache(payload));
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
    expect(await recovered.json()).toEqual({ items: [image] });
  });

  it("keeps usable markers when another cache reply has no items array", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.fetch.mockImplementation(async (request) =>
      new URL(request.url).searchParams.get("markerId") === "broken"
        ? Response.json({ items: null })
        : Response.json({ items: [image] }),
    );
    const response = publicReadResponse(
      await readPublicImagesFromWorkersCache({
        markerIds: ["marker", "broken"],
        limit: 6,
        cacheNamespace: "prod",
        assetBaseUrl: "https://assets.example",
      }),
    );
    expect(response.status).toBe(200);
    // Caching a partial list would hide the failed marker even after it recovers.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      items: [image],
      partial: true,
      failedMarkerIds: ["broken"],
    });
  });

  it("preserves overload backoff when every marker fails by a different cause", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.fetch.mockImplementation(async (request) => {
      if (new URL(request.url).searchParams.get("markerId") === "overloaded") {
        throw Object.assign(new Error("Too much work queued"), { overloaded: true });
      }
      return Response.json({ items: null });
    });
    const response = publicReadResponse(
      await readPublicImagesFromWorkersCache({
        markerIds: ["malformed", "overloaded"],
        limit: 6,
        cacheNamespace: "prod",
        assetBaseUrl: "https://assets.example",
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      code: "PUBLIC_CACHE_READ_FAILED",
      message: "Public cache reads failed.",
    });
  });
});
