import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publicReadResponse } from "@/routes/uploads/responses";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertSubmission } from "@/test/fixtures/submissions";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";
import type { Bindings } from "@/types/app";

import {
  readPublicCommentsFromWorkersCache,
  readPublicImagesFromWorkersCache,
} from "./client/client";
import { PublicReadCache } from "./origin/entrypoint";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  exports: { PublicReadCache: { fetch: mocks.fetch } },
  WorkerEntrypoint: class {
    constructor(
      protected ctx: ExecutionContext,
      protected env: Bindings,
    ) {}
  },
}));
const fetchPublicImagesFromWorkersCache = async (
  payload: Parameters<typeof readPublicImagesFromWorkersCache>[0],
) => publicReadResponse(await readPublicImagesFromWorkersCache(payload));
const fetchPublicCommentsFromWorkersCache = async (
  payload: Parameters<typeof readPublicCommentsFromWorkersCache>[0],
) => publicReadResponse(await readPublicCommentsFromWorkersCache(payload));

let database: TestDatabase;
let backgroundTasks: Promise<unknown>[];
let context: ExecutionContext;
beforeEach(() => {
  mocks.fetch.mockReset();
  database = createTestDatabase();
  backgroundTasks = [];
  context = {
    waitUntil: (promise: Promise<unknown>) => backgroundTasks.push(promise),
  } as unknown as ExecutionContext;
});
afterEach(async () => {
  await Promise.all(backgroundTasks);
  vi.restoreAllMocks();
  database.close();
});

describe("bounded public reads", () => {
  it.each(["images", "comments"])(
    "trims unused %s entries before other marker bodies finish",
    async (kind) => {
      let finishSlow!: () => void;
      const firstItems = [
        { id: "returned", markerId: "first", replies: [] },
        { id: "unused", markerId: "first", replies: [] },
      ];
      // Final output alone cannot show when excess entries were discarded.
      // Observe selection while the slow body is still pending to protect memory use.
      const trimItems = vi.spyOn(firstItems, "slice");
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
      const responsePromise =
        kind === "images"
          ? fetchPublicImagesFromWorkersCache(payload)
          : fetchPublicCommentsFromWorkersCache(payload);
      try {
        await vi.waitFor(() => expect(finishSlow).toBeTypeOf("function"));
        expect(trimItems).toHaveBeenCalledWith(0, 1);
      } finally {
        finishSlow();
        await responsePromise;
      }
      expect(await (await responsePromise).json()).toEqual({ items: [firstItems[0]] });
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
    let drainBodies = false;
    mocks.fetch.mockImplementation(async (request: Request) => {
      active += 1;
      peak = Math.max(peak, active);
      const markerId = new URL(request.url).searchParams.get("markerId");
      return {
        ok: true,
        json: () =>
          new Promise((resolve) => {
            const release = () => {
              active -= 1;
              resolve({ items: [{ id: markerId, markerId }] });
            };
            if (drainBodies) {
              release();
            } else {
              releases.push(release);
            }
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
    try {
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
    } finally {
      // Release existing bodies and immediately consume any later bodies. The
      // bounded wait also clears its polling timer if the client never settles.
      drainBodies = true;
      releases.splice(0).forEach((release) => release());
      let settled = false;
      void responsePromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
      await responsePromise;
    }
  });

  it.each(["images", "comments"])(
    "does not cache D1 failures in the %s entrypoint",
    async (kind) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      insertUser(database.sqlite, { uid: "author" });
      insertSubmission(database.sqlite, {
        id: "stored",
        userId: "author",
        kind: kind === "images" ? "image" : "comment",
      });
      importCurrentSubmissions(database);
      const before = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
      database.hooks.beforeQuery = (sql) => {
        if (/ugc_(submissions|public_submissions)/.test(sql)) {
          throw new Error("D1_ERROR: D1 DB is overloaded.");
        }
      };
      const bindings = createMockBindings({ DB: database.db });
      const cache = new PublicReadCache(context, bindings.bindings);
      const request = new Request(
        `https://public-read-cache.internal/${kind}?markerId=marker-1&limit=6&replyLimit=3&namespace=prod&assetBaseUrl=https://assets.example`,
      );
      const response = await cache.fetch(request);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toMatchObject({ code: "DEPENDENCY_OVERLOADED" });
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);

      database.hooks.beforeQuery = undefined;
      const recovered = await cache.fetch(request);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ items: [{ id: "stored" }] });
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);
    },
  );

  it("redacts unexpected origin failures without retry hints and recovers stored comments", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    insertUser(database.sqlite, { uid: "author" });
    insertSubmission(database.sqlite, { id: "stored", userId: "author" });
    importCurrentSubmissions(database);
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
    database.hooks.beforeQuery = () => {
      throw new Error("D1_ERROR: private database detail");
    };
    const bindings = createMockBindings({ DB: database.db });
    const cache = new PublicReadCache(context, bindings.bindings);
    const request = new Request(
      "https://public-read-cache.internal/comments?markerId=marker-1&limit=6&replyLimit=0&namespace=prod",
    );
    const failed = await cache.fetch(request);
    expect(failed.status).toBe(500);
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
    expect(failed.headers.get("retry-after")).toBeNull();
    expect(await failed.json()).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal server error.",
    });
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);

    database.hooks.beforeQuery = undefined;
    const recovered = await cache.fetch(request);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ items: [{ id: "stored" }] });
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);
  });
});
