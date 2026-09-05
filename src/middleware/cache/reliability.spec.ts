import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InFlightBatchLoader } from "./inFlightBatchLoader";
import type { Bindings } from "../../types/app";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), images: vi.fn(), comments: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  exports: { PublicReadCache: { fetch: mocks.fetch } },
  WorkerEntrypoint: class {
    constructor(protected ctx: ExecutionContext, protected env: Bindings) {}
  }
}));
vi.mock("../../services/upload/listPublicImages", () => ({ listCachedPublicImagesByMarker: mocks.images }));
vi.mock("../../services/upload/listPublicComments", () => ({ listCachedPublicCommentsByMarker: mocks.comments }));
import { fetchPublicCommentsFromWorkersCache, fetchPublicImagesFromWorkersCache } from "./publicReadClient";
import { PublicReadCache } from "./publicReadCache";

beforeEach(() => mocks.fetch.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("bounded public reads", () => {
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
        json: () => new Promise((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve({ items: [{ id: markerId, markerId }] });
          });
        })
      };
    });
    const markerIds = Array.from({ length: 20 }, (_, index) => `marker-${String(index).padStart(2, "0")}`);
    const responsePromise = fetchPublicImagesFromWorkersCache({
      markerIds, limit: 6, cacheNamespace: "prod", assetBaseUrl: "https://assets.example"
    });
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    expect(mocks.fetch).toHaveBeenCalledTimes(8);
    releases.splice(0).reverse().forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    const response = await responsePromise;
    expect(peak).toBe(8);
    expect(await response.json()).toEqual({ items: markerIds.map((markerId) => ({ id: markerId, markerId })) });
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
      markerIds: ["empty", "failed"], limit: 20, replyLimit: 3, cacheNamespace: "prod"
    });
    expect(partial.status).toBe(200);
    expect(partial.headers.get("cache-control")).toBe("private, no-store");
    expect(await partial.json()).toEqual({ items: [], partial: true });
    const failed = await fetchPublicCommentsFromWorkersCache({
      markerIds: ["failed"], limit: 20, replyLimit: 3, cacheNamespace: "prod"
    });
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("5");
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it("handles platform overload before the cache entrypoint is reached", async () => {
    mocks.fetch.mockRejectedValue(Object.assign(new Error("Too much work queued"), { overloaded: true }));
    const response = await fetchPublicImagesFromWorkersCache({
      markerIds: ["failed"], limit: 6, cacheNamespace: "prod", assetBaseUrl: "https://assets.example"
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["images", "comments"])("does not cache D1 failures in the %s entrypoint", async (kind) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks[kind as "images" | "comments"].mockRejectedValueOnce(new Error("D1_ERROR: D1 DB is overloaded."));
    const cache = new PublicReadCache({ waitUntil: vi.fn() } as unknown as ExecutionContext, {} as Bindings);
    const response = await cache.fetch(new Request(
      `https://public-read-cache.internal/${kind}?markerId=marker-1&limit=6&replyLimit=3&namespace=prod&assetBaseUrl=https://assets.example`
    ));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ code: "DEPENDENCY_OVERLOADED" });
  });

  it("serializes DB batches even when more loads arrive during a flush", async () => {
    const loader = new InFlightBatchLoader<string>(2);
    const releases: Array<() => void> = [];
    const batchLoad = vi.fn((keys: string[]) => new Promise<Map<string, string>>((resolve) => {
      releases.push(() => resolve(new Map(keys.map((key) => [key, key]))));
    }));
    const first = loader.load("first", batchLoad);
    const duplicate = loader.load("first", batchLoad);
    const second = loader.load("second", batchLoad);
    expect(first).toBe(duplicate);
    await vi.waitFor(() => expect(batchLoad).toHaveBeenCalledTimes(1));
    const third = loader.load("third", batchLoad);
    await Promise.resolve();
    expect(batchLoad).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    await vi.waitFor(() => expect(batchLoad).toHaveBeenCalledTimes(2));
    releases.shift()!();
    await expect(third).resolves.toBe("third");
  });

  it("rejects all affected keys and allows subsequent loads after DB failure", async () => {
    const loader = new InFlightBatchLoader<string>(2);
    const batchLoad = vi.fn().mockRejectedValueOnce(new Error("D1 overloaded"))
      .mockImplementation(async (keys: string[]) => new Map(keys.map((key) => [key, key])));
    const results = await Promise.allSettled([loader.load("first", batchLoad), loader.load("second", batchLoad)]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    await expect(loader.load("first", batchLoad)).resolves.toBe("first");
  });
});
