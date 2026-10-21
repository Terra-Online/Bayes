import { readFileSync } from "node:fs";

import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/errors";
import { createUGCImageDatabase } from "@/test/ugcImageDatabase";
import type { AppEnv, AuthUser } from "@/types/app";

vi.mock("@/middleware/auth", () => ({
  requireAuth: async (c: { get: (key: string) => unknown }, next: () => Promise<void>) => {
    if (!c.get("authUser")) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    await next();
  },
}));
vi.mock("@/middleware/rate-limit", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
import { createRoutes } from "./createRoutes";

let database: ReturnType<typeof createUGCImageDatabase>;
const get = vi.fn();
beforeEach(() => {
  database = createUGCImageDatabase();
  database.sqlite.exec(`
    ALTER TABLE ugc_submissions ADD COLUMN mime_type TEXT DEFAULT 'image/webp';
    ALTER TABLE ugc_submissions ADD COLUMN poi_type TEXT DEFAULT 'sample';
    ALTER TABLE ugc_submissions ADD COLUMN moderation_note TEXT;
    ALTER TABLE ugc_submissions ADD COLUMN snapshot_id TEXT DEFAULT 'current';
    ALTER TABLE ugc_submissions ADD COLUMN updated_at TEXT DEFAULT '2026-09-05T12:00:00Z';
    ${readFileSync(new URL("../../../migrations/0035_ugc_review_events.sql", import.meta.url), "utf8")}
    CREATE TABLE notification_messages (submission_id TEXT, dedupe_key TEXT UNIQUE, created_at TEXT);
  `);
  get.mockReset();
  get.mockResolvedValue({
    body: new Uint8Array([82, 73, 70, 70]),
    httpEtag: '"test"',
    httpMetadata: { contentType: "image/webp" },
    writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/webp"),
  });
});
afterEach(() => {
  database.sqlite.close();
  vi.restoreAllMocks();
});

function request(id: string, uid?: string, headers?: HeadersInit) {
  return requestPath(`/contributions/${id}/preview`, uid, headers);
}
function requestPath(path: string, uid?: string, headers?: HeadersInit) {
  const app = new Hono<AppEnv<{ authUser?: AuthUser }>>();
  app.onError((error) => {
    if (error instanceof ApiError) {
      return new Response(error.code, { status: error.status });
    }
    throw error;
  });
  if (uid) {
    app.use("*", async (c, next) => {
      c.set("authUser", { uid } as AuthUser);
      await next();
    });
  }
  app.route("/me/v1", createRoutes());
  return app.request(
    `http://localhost/me/v1${path}`,
    { headers },
    {
      DB: database.db,
      UGC_BUCKET: { get } as unknown as R2Bucket,
    },
  );
}

it("serves an owner's image bytes with private cache headers", async () => {
  const response = await request("photo", "author");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/webp");
  expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600, must-revalidate");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Authorization");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
  expect(get).toHaveBeenCalledWith("images/photo.webp", { onlyIf: expect.any(Headers) });
});

it("keeps historical previews available to their owner only", async () => {
  database.sqlite.exec("UPDATE ugc_submissions SET status = 'stale' WHERE id = 'photo'");
  expect((await request("photo", "author")).status).toBe(200);
  get.mockClear();
  expect((await request("photo", "other")).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
});

it("rejects unauthenticated requests and missing image objects", async () => {
  expect((await request("photo")).status).toBe(401);
  expect(get).not.toHaveBeenCalled();
  get.mockResolvedValue(null);
  expect((await request("photo", "author")).status).toBe(404);
});

it("revalidates an owner's cached preview without sending image bytes", async () => {
  get.mockResolvedValueOnce({
    httpEtag: '"test"',
    httpMetadata: { contentType: "image/webp" },
    writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/webp"),
  });
  const response = await request("photo", "author", { "If-None-Match": '"test"' });
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(response.headers.get("etag")).toBe('"test"');
  expect(get.mock.calls[0][1].onlyIf.get("If-None-Match")).toBe('"test"');
  get.mockClear();
  expect((await request("photo", "other", { "If-None-Match": '"test"' })).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
});

it("caches completed overview counts and pages separately by owner and filter", async () => {
  const prepare = vi.spyOn(database.db, "prepare");
  const responses = await Promise.all([
    requestPath("/overview", "author"),
    requestPath("/overview", "author"),
  ]);
  expect(prepare).toHaveBeenCalledTimes(2);
  await requestPath("/overview", "author");
  expect(prepare).toHaveBeenCalledTimes(2);
  type Summary = {
    contributions: { imageCount: number; recent?: unknown };
    loginMethods?: unknown;
  };
  const data = (await responses[0].json()) as Summary;
  expect(data.contributions.imageCount).toBe(3);
  expect(data.contributions.recent).toBeUndefined();
  expect(data.loginMethods).toBeUndefined();
  expect(responses[0].headers.get("Cache-Control")).toBe("private, max-age=15, must-revalidate");
  const other = (await (await requestPath("/overview", "other")).json()) as Summary;
  expect(other.contributions.imageCount).toBe(0);
  prepare.mockClear();
  const image = await requestPath("/contributions?kind=image&limit=1", "author");
  expect(((await image.json()) as { items: unknown[] }).items).toHaveLength(1);
  await requestPath("/contributions?kind=image&limit=1", "author");
  expect(prepare).toHaveBeenCalledOnce();
  await requestPath("/contributions?kind=comment&limit=1", "author");
  await requestPath("/contributions?kind=image&limit=1", "other");
  expect(prepare).toHaveBeenCalledTimes(3);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15_001);
  await requestPath("/contributions?kind=image&limit=1", "author");
  expect(prepare).toHaveBeenCalledTimes(4);
});

it("keeps concurrent overview queries independent when the first query fails", async () => {
  const prepare = database.db.prepare.bind(database.db);
  let rejectFirst!: (error: Error) => void;
  vi.spyOn(database.db, "prepare")
    .mockImplementationOnce(
      () =>
        ({
          bind() {
            return this;
          },
          first: () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            }),
        }) as unknown as D1PreparedStatement,
    )
    .mockImplementation(prepare);
  const first = requestPath("/overview", "author");
  const rejected = expect(first).rejects.toThrow("first request failed");
  await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
  try {
    expect((await requestPath("/overview", "author")).status).toBe(200);
  } finally {
    rejectFirst(new Error("first request failed"));
  }
  await rejected;
  expect((await requestPath("/overview", "author")).status).toBe(200);
});
