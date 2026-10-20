import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn()
}));

vi.mock("cloudflare:workers", () => ({
  exports: {
    PublicReadCache: {
      fetch: mocks.fetch
    }
  }
}));

import { publicReadResponse, readPublicImagesFromWorkersCache } from "./client";
const fetchPublicImagesFromWorkersCache = async (payload: Parameters<typeof readPublicImagesFromWorkersCache>[0]) => publicReadResponse(await readPublicImagesFromWorkersCache(payload));

describe("fetchPublicImagesFromWorkersCache", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
  });

  it("keeps aggregate data structured until the HTTP response boundary", async () => {
    const upstream = Response.json({ items: [{ id: "image", markerId: "marker" }] });
    mocks.fetch.mockResolvedValue(upstream);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const result = await readPublicImagesFromWorkersCache({
        markerIds: ["marker"], limit: 6, cacheNamespace: "prod", assetBaseUrl: "https://assets.example"
      });
      expect(stringify).not.toHaveBeenCalled();
      expect(result).not.toBeInstanceOf(Response);
      expect(result).toMatchObject({ payload: { items: [{ id: "image", markerId: "marker" }] } });
    } finally {
      stringify.mockRestore();
    }
  });

  it("returns successful markers as an uncacheable partial response", async () => {
    mocks.fetch.mockImplementation((request: Request) => {
      const markerId = new URL(request.url).searchParams.get("markerId");
      if (markerId === "failed") {
        return Promise.reject(new Error("Network connection lost."));
      }
      return Promise.resolve(Response.json({
        items: [{ id: "image-1", markerId }]
      }));
    });

    const response = await fetchPublicImagesFromWorkersCache({
      markerIds: ["success", "failed"],
      limit: 6,
      cacheNamespace: "prod",
      assetBaseUrl: "https://assets.example.com"
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-oem-partial-response")).toBe("true");
    expect(response.headers.get("x-oem-failed-marker-count")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      items: [{ id: "image-1", markerId: "success" }],
      partial: true,
      failedMarkerIds: ["failed"]
    });
  });

  it("returns an error when every marker read fails", async () => {
    mocks.fetch.mockRejectedValue(new Error("Network connection lost."));

    const response = await fetchPublicImagesFromWorkersCache({
      markerIds: ["first", "second"],
      limit: 6,
      cacheNamespace: "prod",
      assetBaseUrl: "https://assets.example.com"
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "PUBLIC_CACHE_READ_FAILED"
    });
  });
});
