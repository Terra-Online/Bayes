import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  exports: {
    PublicReadCache: {
      fetch: mocks.fetch,
    },
  },
}));

import { readPublicImagesFromWorkersCache } from "./client";

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
        markerIds: ["marker"],
        limit: 6,
        cacheNamespace: "prod",
        assetBaseUrl: "https://assets.example",
      });
      expect(stringify).not.toHaveBeenCalled();
      expect(result).not.toBeInstanceOf(Response);
      expect(result).toMatchObject({ payload: { items: [{ id: "image", markerId: "marker" }] } });
    } finally {
      stringify.mockRestore();
    }
  });
});
