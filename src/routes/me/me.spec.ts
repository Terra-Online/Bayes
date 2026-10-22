import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi, type Mocked } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { onAppError } from "@/middleware/error-handler";
import type { ContributionItem } from "@/repositories/me";
import { createMockBindings, createMockR2Object, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, type SeededSession } from "@/test/fixtures/auth";
import { seedImageReadScenario } from "@/test/fixtures/imageReadScenario";
import { insertNotification } from "@/test/fixtures/notifications";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let mocks: MockBindings;
let app: Hono<AppEnv>;
let sessions: Map<string, SeededSession>;
beforeEach(() => {
  database = createTestDatabase();
  seedImageReadScenario(database.sqlite);
  sessions = new Map();
  for (const uid of ["author", "other"]) {
    const user = insertAuthUser(database.sqlite, { id: uid });
    sessions.set(uid, insertSession(database.sqlite, { userId: user.id }));
  }

  mocks = createMockBindings({ DB: database.db });
  mocks.ugcBucket.get.mockImplementation(async () => {
    const response = new Response(new Uint8Array([82, 73, 70, 70]));
    return {
      ...previewMetadata(),
      body: response.body!,
      get bodyUsed() {
        return response.bodyUsed;
      },
      arrayBuffer: () => response.arrayBuffer(),
      bytes: () => response.bytes(),
      text: () => response.text(),
      json: () => response.json(),
      blob: () => response.blob(),
    } satisfies R2ObjectBody;
  });
  app = new Hono<AppEnv>();
  app.onError(onAppError);
  app.route("/me/v1", createRoutes());
});
afterEach(() => {
  database.close();
  vi.restoreAllMocks();
});

function request(id: string, uid?: string, headers?: HeadersInit) {
  return requestPath(`/contributions/${id}/preview`, uid, headers);
}
async function requestPath(path: string, uid?: string, headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  if (uid) {
    requestHeaders.set("authorization", sessions.get(uid)!.headers.authorization);
  }
  return runWithAuthRequest(() =>
    app.request(`http://localhost/me/v1${path}`, { headers: requestHeaders }, mocks.bindings),
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
  expect(mocks.ugcBucket.get).toHaveBeenCalledWith("images/photo.webp", {
    onlyIf: expect.any(Headers),
  });
});

it("keeps historical previews available to their owner only", async () => {
  database.sqlite.exec("UPDATE ugc_submissions SET status = 'stale' WHERE id = 'photo'");
  expect((await request("photo", "author")).status).toBe(200);
  mocks.ugcBucket.get.mockClear();
  expect((await request("photo", "other")).status).toBe(404);
  expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
});

it("rejects unauthenticated requests and missing image objects", async () => {
  expect((await request("photo")).status).toBe(401);
  expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
  mocks.ugcBucket.get.mockResolvedValue(null);
  expect((await request("photo", "author")).status).toBe(404);
});

it("revalidates an owner's cached preview without sending image bytes", async () => {
  // Vitest models only R2.get's last overload; conditional reads can return
  // metadata without a body. Keep the actual R2Object shape for the 304 path.
  vi.mocked(mocks.ugcBucket.get, { partial: true }).mockResolvedValueOnce(previewMetadata());
  const response = await request("photo", "author", { "If-None-Match": '"test"' });
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(response.headers.get("etag")).toBe('"test"');
  const condition = mocks.ugcBucket.get.mock.calls[0][1]?.onlyIf;
  expect(condition).toBeInstanceOf(Headers);
  expect((condition as Headers).get("If-None-Match")).toBe('"test"');
  mocks.ugcBucket.get.mockClear();
  expect((await request("photo", "other", { "If-None-Match": '"test"' })).status).toBe(404);
  expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
});

it("caches completed overview counts and pages separately by owner and filter", async () => {
  const { entered, release } = pauseFirstOverviewQuery();
  const prepare = vi.mocked(database.db.prepare);
  const businessQueries = () => prepare.mock.calls.filter(([sql]) => /ugc_submissions/.test(sql));
  const first = requestPath("/overview", "author");
  await entered;
  let secondResponse: Response | undefined;
  const second = requestPath("/overview", "author").then((response) => {
    secondResponse = response;
    return response;
  });
  try {
    // Authentication may finish at different times. Hold the first business read
    // so the second must complete against a still-cold cache.
    await vi.waitFor(() => expect(secondResponse?.status).toBe(200));
  } finally {
    release();
  }
  const responses = await Promise.all([first, second]);
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
  const { entered, fail } = pauseFirstOverviewQuery();
  const first = requestPath("/overview", "author");
  await entered;
  let secondResponse: Response | undefined;
  const second = requestPath("/overview", "author").then((response) => {
    secondResponse = response;
  });
  try {
    // Prove completion while the first business query is still blocked.
    await vi.waitFor(() => expect(secondResponse?.status).toBe(200));
  } finally {
    fail(new Error("first request failed"));
  }
  await second;
  const failed = await first;
  expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  expect((await requestPath("/overview", "author")).status).toBe(200);
});

interface OverviewQueryGate {
  entered: Promise<void>;
  release: () => void;
  fail: (error: Error) => void;
}

/** Suspend only the first overview query; authentication and later reads stay real. */
function pauseFirstOverviewQuery(): OverviewQueryGate {
  let enter!: () => void;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const prepare = database.db.prepare.bind(database.db);
  let blocked = false;
  vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!blocked && /AS image_count/.test(sql)) {
      blocked = true;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        bound.first = async <Result>(column?: string) => {
          enter();
          await pending;
          return column === undefined ? first<Result>() : first<Result>(column);
        };
        return bound;
      };
    }
    return statement;
  });
  return { entered, release, fail };
}

function previewMetadata(): Mocked<R2Object> {
  const object = createMockR2Object({
    key: "images/photo.webp",
    size: 4,
    httpMetadata: { contentType: "image/webp" },
  });
  object.writeHttpMetadata.mockImplementation((headers) =>
    headers.set("Content-Type", "image/webp"),
  );
  return { ...object, httpEtag: '"test"' };
}

async function list(): Promise<{ items: ContributionItem[] }> {
  const response = await requestPath("/contributions?limit=20", "author");
  expect(response.status).toBe(200);
  return response.json();
}

interface LegacyReviewNotificationInput {
  submissionId: string;
  from: string;
  to: string;
  snapshot?: string;
  at?: string;
}

function insertLegacyReviewNotification({
  submissionId: id,
  from,
  to,
  snapshot = "current",
  at = "2026-09-04T12:00:00Z",
}: LegacyReviewNotificationInput): void {
  const key = `system:${id}:${snapshot}:${from}:${to}`;
  const notification = insertNotification(database.sqlite, {
    id: key,
    recipientUserId: "author",
    createdAt: at,
  });
  database.sqlite
    .prepare(`INSERT INTO notification_messages
    (id, notification_id, submission_id, dedupe_key, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(key, notification.id, id, key, at);
}

it("returns portable preview paths and retains complete historical comment content", async () => {
  const content = "**a long comment** ".repeat(30);
  database.sqlite
    .prepare("UPDATE ugc_submissions SET kind = 'comment', content = ? WHERE id = 'mine'")
    .run(content);
  const { items } = await list();
  expect(items.find((item) => item.id === "photo")?.previewUrl).toBe(
    "/me/v1/contributions/photo/preview",
  );
  expect(items.find((item) => item.id === "mine")).toMatchObject({ content, previewUrl: null });
});

it("retains a completed manual review for the current published snapshot only", async () => {
  insertLegacyReviewNotification({
    submissionId: "photo",
    from: "pending_openai",
    to: "pending_audit",
  });
  insertLegacyReviewNotification({
    submissionId: "mine",
    from: "pending_openai",
    to: "pending_audit",
    snapshot: "old-edit",
  });
  const { items } = await list();
  expect(items.find((item) => item.id === "photo")?.review).toMatchObject({
    manual: true,
    published: true,
  });
  expect(items.find((item) => item.id === "mine")?.review).toMatchObject({
    manual: false,
    published: true,
  });
});

it("distinguishes an archived public submission from one recalled before approval", async () => {
  database.sqlite.exec("UPDATE ugc_submissions SET status = 'stale'");
  insertLegacyReviewNotification({
    submissionId: "photo",
    from: "pending_openai",
    to: "pending_audit",
  });
  insertLegacyReviewNotification({ submissionId: "photo", from: "pending_audit", to: "active" });
  insertLegacyReviewNotification({ submissionId: "photo", from: "active", to: "stale" });
  const { items } = await list();
  expect(items.find((item) => item.id === "photo")?.review).toMatchObject({
    manual: true,
    published: true,
  });
  expect(items.find((item) => item.id === "mine")?.review).toMatchObject({
    manual: false,
    published: false,
  });
});

it("recognizes an ongoing manual review before any notification is available", async () => {
  database.sqlite.exec("UPDATE ugc_submissions SET status = 'pending_audit' WHERE id = 'photo'");
  expect((await list()).items.find((item) => item.id === "photo")?.review).toMatchObject({
    manual: true,
    published: false,
  });
});

it("returns real decision times without borrowing a previous snapshot's timestamps", async () => {
  insertLegacyReviewNotification({
    submissionId: "photo",
    from: "pending_openai",
    to: "pending_audit",
    snapshot: "current",
    at: "2026-09-02T12:00:00Z",
  });
  insertLegacyReviewNotification({
    submissionId: "photo",
    from: "pending_audit",
    to: "active",
    snapshot: "current",
    at: "2026-09-03T12:00:00Z",
  });
  insertLegacyReviewNotification({
    submissionId: "mine",
    from: "pending_audit",
    to: "active",
    snapshot: "old-edit",
    at: "2026-09-02T10:00:00Z",
  });
  database.sqlite.exec("UPDATE ugc_submissions SET status = 'stale' WHERE id = 'photo'");
  const { items } = await list();
  expect(items.find((item) => item.id === "photo")?.review.times).toEqual({
    uploaded: "2026-09-01",
    ai: "2026-09-02T12:00:00Z",
    manual: "2026-09-03T12:00:00Z",
    public: "2026-09-03T12:00:00Z",
    archived: "2026-09-05T12:00:00Z",
  });
  expect(items.find((item) => item.id === "mine")?.review.times.public).toBeNull();
});

const paths: Array<[string, Array<[string, string, string]>, string[]]> = [
  ["stale", [["pending_openai", "stale", "manual_moderation"]], ["uploaded", "manual", "archived"]],
  ["stale", [["pending_openai", "stale", "auto_moderation"]], ["uploaded", "ai", "archived"]],
  ["stale", [["pending_openai", "stale", "user_action"]], ["uploaded", "archived"]],
  [
    "stale",
    [
      ["pending_openai", "pending_audit", "auto_moderation"],
      ["pending_audit", "stale", "manual_moderation"],
    ],
    ["uploaded", "ai", "manual", "archived"],
  ],
  [
    "stale",
    [
      ["pending_openai", "pending_audit", "auto_moderation"],
      ["pending_audit", "stale", "user_action"],
    ],
    ["uploaded", "ai", "archived"],
  ],
  ["active", [["pending_openai", "active", "manual_moderation"]], ["uploaded", "manual", "public"]],
  ["active", [["pending_openai", "active", "auto_moderation"]], ["uploaded", "ai", "public"]],
  [
    "stale",
    [
      ["pending_openai", "active", "auto_moderation"],
      ["active", "stale", "user_action"],
    ],
    ["uploaded", "ai", "public", "archived"],
  ],
  [
    "stale",
    [
      ["pending_openai", "active", "auto_moderation"],
      ["flagged", "stale", "manual_moderation"],
    ],
    ["uploaded", "ai", "public", "manual", "archived"],
  ],
  [
    "active",
    [
      ["pending_openai", "stale", "manual_moderation"],
      ["stale", "active", "manual_moderation"],
    ],
    ["uploaded", "manual", "archived", "manual", "public"],
  ],
  [
    "pending_audit",
    [["pending_openai", "pending_audit", "auto_moderation"]],
    ["uploaded", "ai", "manual"],
  ],
];
it.each(paths)("reconstructs %s from actual decisions: %j", async (status, events, expected) => {
  database.sqlite.prepare("UPDATE ugc_submissions SET status = ? WHERE id = 'photo'").run(status);
  events.forEach(([from, to, source], index) => {
    database.sqlite
      .prepare(`INSERT INTO ugc_review_events
      (submission_id, snapshot_id, from_status, to_status, source, created_at)
      VALUES ('photo', 'current', ?, ?, ?, ?)`)
      .run(from, to, source, `2026-09-0${index + 2}T12:00:00Z`);
  });
  // Events from a different edit must never become part of this path.
  database.sqlite.exec(`INSERT INTO ugc_review_events
    (submission_id, snapshot_id, from_status, to_status, source, created_at)
    VALUES ('photo', 'old-edit', 'pending_openai', 'active', 'auto_moderation', '2026-09-01')`);
  const review = (await list()).items.find((item) => item.id === "photo")?.review;
  expect(review?.path.map((step) => step.key)).toEqual(expected);
});

it("keeps a historical publication with an unknown approval time, without inventing AI review", async () => {
  const review = (await list()).items.find((item) => item.id === "photo")?.review;
  expect(review?.path).toEqual([
    { key: "uploaded", at: "2026-09-01" },
    { key: "public", at: null },
  ]);
});

it.each([
  ["OpenAI moderation passed: clean", "stale", ["uploaded", "ai", "public", "archived"]],
  ["OpenAI moderation needs audit: flagged", "active", ["uploaded", "ai", "manual", "public"]],
  [
    "OpenAI moderation flagged: unsafe",
    "active",
    ["uploaded", "ai", "archived", "manual", "public"],
  ],
])(
  "uses old moderation evidence without inventing decision times: %s",
  async (note, status, expected) => {
    database.sqlite
      .prepare("UPDATE ugc_submissions SET status = ?, moderation_note = ? WHERE id = 'photo'")
      .run(status, note);
    const path = (await list()).items.find((item) => item.id === "photo")?.review.path;
    expect(path?.map((step) => step.key)).toEqual(expected);
    expect(path?.find((step) => step.key === "ai")?.at).toBeNull();
  },
);

it("omits AI when automation explicitly bypasses AI review", async () => {
  database.sqlite.exec(`UPDATE ugc_submissions SET status = 'pending_audit' WHERE id = 'photo';
    INSERT INTO ugc_review_events
      (submission_id, snapshot_id, from_status, to_status, source, created_at, ai_reviewed)
      VALUES ('photo', 'current', 'pending_openai', 'pending_audit', 'auto_moderation', '2026-09-04', 0)`);
  expect(
    (await list()).items.find((item) => item.id === "photo")?.review.path.map((step) => step.key),
  ).toEqual(["uploaded", "manual"]);
});

it("keeps the latest restored publication time instead of the first approval", async () => {
  insertLegacyReviewNotification({
    submissionId: "photo",
    from: "pending_openai",
    to: "active",
    snapshot: "current",
    at: "2026-09-02T12:00:00Z",
  });
  database.sqlite.exec(`INSERT INTO ugc_review_events
    (submission_id, snapshot_id, from_status, to_status, source, created_at)
    VALUES ('photo', 'current', 'pending_openai', 'active', 'auto_moderation', '2026-09-02T12:00:00Z'),
           ('photo', 'current', 'active', 'stale', 'user_action', '2026-09-03T12:00:00Z'),
           ('photo', 'current', 'stale', 'active', 'manual_moderation', '2026-09-04T12:00:00Z')`);
  expect((await list()).items.find((item) => item.id === "photo")?.review.times.public).toBe(
    "2026-09-04T12:00:00Z",
  );
});
