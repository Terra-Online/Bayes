import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/errors";
import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { seedImageReadScenario } from "@/test/fixtures/imageReadScenario";
import type { AppEnv, AuthUser } from "@/types/app";

vi.mock("@/middleware/rate-limit", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
import { createRoutes } from "./createRoutes";

let database: ReturnType<typeof createTestDatabase>;
const get = vi.fn();
let sessions: Map<string, ReturnType<typeof insertSession>>;
beforeEach(() => {
  database = createTestDatabase();
  seedImageReadScenario(database.sqlite);
  sessions = new Map();
  for (const uid of ["author", "other"]) {
    const user = insertAuthUser(database.sqlite, { id: uid });
    sessions.set(uid, insertSession(database.sqlite, { userId: user.id }));
  }

  get.mockReset();
  get.mockResolvedValue({
    body: new Uint8Array([82, 73, 70, 70]),
    httpEtag: '"test"',
    httpMetadata: { contentType: "image/webp" },
    writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/webp"),
  });
});
afterEach(() => {
  database.close();
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
  app.route("/me/v1", createRoutes());
  const requestHeaders = new Headers(headers);
  if (uid) {
    requestHeaders.set("authorization", sessions.get(uid)!.headers.authorization);
  }
  return app.request(
    `http://localhost/me/v1${path}`,
    { headers: requestHeaders },
    {
      DB: database.db,
      ...testAuthConfig,
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
  // Warm authentication so both concurrent requests enter the business query together.
  await request("missing", "author");
  const prepare = vi.spyOn(database.db, "prepare");
  const businessQueries = () => prepare.mock.calls.filter(([sql]) => /ugc_submissions/.test(sql));
  const responses = await Promise.all([
    requestPath("/overview", "author"),
    requestPath("/overview", "author"),
  ]);
  expect(businessQueries()).toHaveLength(2);
  await requestPath("/overview", "author");
  expect(businessQueries()).toHaveLength(2);
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
  expect(businessQueries()).toHaveLength(1);
  await requestPath("/contributions?kind=comment&limit=1", "author");
  await requestPath("/contributions?kind=image&limit=1", "other");
  expect(businessQueries()).toHaveLength(3);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15_001);
  await requestPath("/contributions?kind=image&limit=1", "author");
  expect(businessQueries()).toHaveLength(4);
});

it("keeps concurrent overview queries independent when the first query fails", async () => {
  await request("missing", "author");
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
