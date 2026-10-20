import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "../types/app";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), images: vi.fn(), comments: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  exports: { PublicReadCache: { fetch: mocks.fetch } },
  WorkerEntrypoint: class {
    constructor(
      protected ctx: ExecutionContext,
      protected env: Bindings,
    ) {}
  },
}));
vi.mock("./origin/markerImages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./origin/markerImages")>()),
  listCachedPublicImagesByMarker: mocks.images,
}));
vi.mock("./origin/markerComments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./origin/markerComments")>()),
  listCachedPublicCommentsByMarker: mocks.comments,
}));
import {
  publicReadResponse,
  readPublicImagesFromWorkersCache,
  readPublicCommentsFromWorkersCache,
} from "./client/client";
const fetchPublicImagesFromWorkersCache = async (
  payload: Parameters<typeof readPublicImagesFromWorkersCache>[0],
) => publicReadResponse(await readPublicImagesFromWorkersCache(payload));
const fetchPublicCommentsFromWorkersCache = async (
  payload: Parameters<typeof readPublicCommentsFromWorkersCache>[0],
) => publicReadResponse(await readPublicCommentsFromWorkersCache(payload));
import { PublicReadCache } from "./origin/entrypoint";

beforeEach(() => mocks.fetch.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("bounded public reads", () => {
  it.each(["images", "comments"])(
    "releases unused %s entries before other marker bodies finish",
    async (kind) => {
      let finishSlow!: () => void;
      const firstItems = [
        { id: "returned", markerId: "first", replies: [] },
        { id: "unused", markerId: "first", replies: [] },
      ];
      const select = vi.spyOn(firstItems, "slice");
      mocks.fetch.mockImplementation(async (request: Request) => ({
        ok: true,
        json: () =>
          new URL(request.url).searchParams.get("markerId") === "first"
            ? Promise.resolve({ items: firstItems })
            : new Promise((resolve) => {
                finishSlow = () => resolve({ items: [] });
              }),
      }));
      const payload = {
        markerIds: ["first", "slow"],
        limit: 1,
        replyLimit: 1,
        cacheNamespace: "prod" as const,
        assetBaseUrl: "https://assets.example",
      };
      const pending =
        kind === "images"
          ? fetchPublicImagesFromWorkersCache(payload)
          : fetchPublicCommentsFromWorkersCache(payload);
      await vi.waitFor(() => expect(finishSlow).toBeTypeOf("function"));
      try {
        expect(select).toHaveBeenCalledWith(0, 1);
      } finally {
        finishSlow();
        await pending;
      }
      expect(await (await pending).json()).toEqual({ items: [firstItems[0]] });
    },
  );

  it("records bounded failure diagnostics including response-body failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.fetch.mockImplementation(async (request: Request) => {
      if (new URL(request.url).searchParams.get("markerId") === "success") {
        return Response.json({ items: [] });
      }
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Network connection lost.");
        },
      };
    });
    const response = await fetchPublicImagesFromWorkersCache({
      markerIds: ["success", "failed-1", "failed-2", "failed-3", "failed-4"],
      limit: 6,
      cacheNamespace: "prod",
      assetBaseUrl: "https://assets.example",
    });
    expect(response.headers.get("x-oem-failed-marker-count")).toBe("4");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "[public-read] partial marker response",
      expect.objectContaining({
        kind: "image",
        failedMarkerCount: 4,
        totalMarkerCount: 5,
        failures: Array.from({ length: 3 }, () =>
          expect.objectContaining({
            stage: "body",
            upstreamStatus: 200,
            message: "Network connection lost.",
          }),
        ),
      }),
    );
  });

  it("limits fanout until response bodies are consumed and preserves marker order", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    mocks.fetch.mockImplementation(async (request: Request) => {
      active += 1;
      peak = Math.max(peak, active);
      const markerId = new URL(request.url).searchParams.get("markerId");
      return {
        ok: true,
        json: () =>
          new Promise((resolve) => {
            releases.push(() => {
              active -= 1;
              resolve({ items: [{ id: markerId, markerId }] });
            });
          }),
      };
    });
    const markerIds = Array.from(
      { length: 20 },
      (_, index) => `marker-${String(index).padStart(2, "0")}`,
    );
    const responsePromise = fetchPublicImagesFromWorkersCache({
      markerIds,
      limit: 6,
      cacheNamespace: "prod",
      assetBaseUrl: "https://assets.example",
    });
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    expect(mocks.fetch).toHaveBeenCalledTimes(8);
    releases
      .splice(0)
      .reverse()
      .forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    const response = await responsePromise;
    expect(peak).toBe(8);
    expect(await response.json()).toEqual({
      items: markerIds.map((markerId) => ({ id: markerId, markerId })),
    });
  });

  it("keeps partial responses uncacheable and propagates overload backoff without retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.fetch.mockImplementation(async (request: Request) => {
      if (new URL(request.url).searchParams.get("markerId") === "failed") {
        return Response.json({}, { status: 503 });
      }
      return Response.json({ items: [] });
    });
    const partial = await fetchPublicCommentsFromWorkersCache({
      markerIds: ["empty", "failed"],
      limit: 20,
      replyLimit: 3,
      cacheNamespace: "prod",
    });
    expect(partial.status).toBe(200);
    expect(partial.headers.get("cache-control")).toBe("private, no-store");
    expect(await partial.json()).toEqual({ items: [], partial: true, failedMarkerIds: ["failed"] });
    const failed = await fetchPublicCommentsFromWorkersCache({
      markerIds: ["failed"],
      limit: 20,
      replyLimit: 3,
      cacheNamespace: "prod",
    });
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("5");
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it("handles platform overload before the cache entrypoint is reached", async () => {
    mocks.fetch.mockRejectedValue(
      Object.assign(new Error("Too much work queued"), { overloaded: true }),
    );
    const response = await fetchPublicImagesFromWorkersCache({
      markerIds: ["failed"],
      limit: 6,
      cacheNamespace: "prod",
      assetBaseUrl: "https://assets.example",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["images", "comments"])(
    "does not cache D1 failures in the %s entrypoint",
    async (kind) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks[kind as "images" | "comments"].mockRejectedValueOnce(
        new Error("D1_ERROR: D1 DB is overloaded."),
      );
      const cache = new PublicReadCache(
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
        {} as Bindings,
      );
      const response = await cache.fetch(
        new Request(
          `https://public-read-cache.internal/${kind}?markerId=marker-1&limit=6&replyLimit=3&namespace=prod&assetBaseUrl=https://assets.example`,
        ),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toMatchObject({ code: "DEPENDENCY_OVERLOADED" });
    },
  );

  it("serves progress statistics through KV and the statistics Durable Object", async () => {
    const markerIndexHash = "a".repeat(64);
    const snapshot = {
      markerIndexHash,
      totalSyncedUsers: 12,
      pointCount: 3,
      counts: "AQID",
      updatedAt: 42,
    };
    const kv = {
      get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(snapshot)),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const stub = { fetch: vi.fn().mockResolvedValue(Response.json(snapshot)) };
    const stats = {
      idFromName: vi.fn().mockReturnValue("stats-id"),
      get: vi.fn().mockReturnValue(stub),
    };
    const cache = new PublicReadCache(
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
      {
        OEM_KV: kv,
        OEM_STATS_DO: stats,
      } as unknown as Bindings,
    );
    const request = new Request(
      `https://public-read-cache.internal/progress-stats?markerIndexHash=${markerIndexHash}`,
    );

    const miss = await cache.fetch(request);
    expect(await miss.json()).toEqual(snapshot);
    expect(miss.headers.get("cache-control")).toBe("public, max-age=10");
    expect(miss.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=60");
    expect(miss.headers.get("x-oem-kv-cache")).toBe("miss");
    expect(stats.idFromName).toHaveBeenCalledWith(markerIndexHash);
    expect(stub.fetch.mock.calls[0]![0].url).toBe(
      `https://progress-stats/state?markerIndexHash=${markerIndexHash}`,
    );
    expect(kv.put).toHaveBeenCalledWith(
      `progress:stats:v2:${markerIndexHash}`,
      JSON.stringify(snapshot),
      { expirationTtl: 60 },
    );

    const hit = await cache.fetch(request);
    expect(await hit.json()).toEqual(snapshot);
    expect(hit.headers.get("x-oem-kv-cache")).toBe("hit");
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});
