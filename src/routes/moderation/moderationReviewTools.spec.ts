import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import {
  createModerationTestFixture,
  type ModerationTestFixture,
} from "@/test/fixtures/moderation";

import { createRoutes } from "./createRoutes";

// The HTTP/auth/service/repository path stays real. Only external services and
// the Workers runtime import are replaced at their boundaries.
const redisCounts = vi.hoisted(() => new Map<string, number>());
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async incrby(key: string, amount: number) {
      const next = (redisCounts.get(key) ?? 0) + amount;
      redisCounts.set(key, next);
      return next;
    }
    async expire() {
      return 1;
    }
  },
}));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: async () => ({ success: true }) } },
}));
vi.mock("@/data/imageCoverageManifest.json", () => ({
  default: {
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    sourceCommit: "synthetic-coverage-manifest",
    regions: {
      valley: {
        name: "Valley",
        types: [
          { key: "ore", name: "Ore", category: "collection", pointIds: ["ore-one", "ore-two"] },
          { key: "archives", name: "Archives", category: "archives", pointIds: ["archive"] },
        ],
      },
      ridge: {
        name: "Ridge",
        types: [
          {
            key: "chest",
            name: "Chest",
            category: "exploration",
            pointIds: ["chest-one", "chest-two"],
          },
        ],
      },
    },
  },
}));
vi.mock("@/lib/karma/karmaConfig.json", () => ({
  default: {
    levels: [{ karma: 0, minPoints: 0 }],
    scoreRules: {
      moderation: {
        approvedImage: 6,
        approvedComment: 2,
        rejectedSubmission: -6,
        approvedImageDailyBackoff: { halfRewardAtCount: 6, counterTtlSeconds: 172800 },
        approvedCommentDailyBackoff: { halfRewardAtCount: 4, counterTtlSeconds: 172800 },
      },
    },
  },
}));

let database: ModerationTestFixture["database"];
let env: ModerationTestFixture["env"];
let createReviewerSession: ModerationTestFixture["createReviewerSession"];
let submission: ModerationTestFixture["submission"];
let request: ModerationTestFixture["request"];
let storedSubmission: ModerationTestFixture["storedSubmission"];
let authorPoints: ModerationTestFixture["authorPoints"];
let reviewEvents: ModerationTestFixture["reviewEvents"];
let notificationMessages: ModerationTestFixture["notificationMessages"];

beforeEach(() => {
  redisCounts.clear();
  const fixture = createModerationTestFixture();
  ({
    database,
    env,
    createReviewerSession,
    submission,
    request,
    storedSubmission,
    authorPoints,
    reviewEvents,
    notificationMessages,
  } = fixture);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected external fetch");
    }),
  );
});

afterEach(() => {
  database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("moderation review tools", () => {
  it("rejects an inverted review date range", async () => {
    const response = await request("/pending?from=2026-09-11T00:00:00Z&to=2026-09-10T00:00:00Z", {
      headers: createReviewerSession(),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Invalid moderation query date range.",
    });
  });

  it("sends an administrator warning to the account resolved by public UID and rejects unknown recipients", async () => {
    env.EMAIL_PROVIDER_MODE = "cloudflare_only";
    const delivered: unknown[] = [];
    env.OEM_ID_MAILS = {
      send: async (mail: unknown) => {
        delivered.push(mail);
        return { messageId: "warning-delivery" };
      },
    } as unknown as SendEmail;
    const headers = createReviewerSession("a");
    const response = await request("/warnings", {
      method: "POST",
      headers,
      body: { publicUid: " 101aa " },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      publicUid: "101AA",
      provider: "cloudflare",
      messageId: "warning-delivery",
    });
    expect(delivered).toEqual([
      expect.objectContaining({
        to: "author@example.test",
        text: expect.stringContaining("101AA"),
      }),
    ]);
    const unknown = await request("/warnings", {
      method: "POST",
      headers,
      body: { publicUid: "999999ZZ" },
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "USER_NOT_FOUND" });
    expect(delivered).toHaveLength(1);
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
  });

  it("refuses test cleanup when a production upload prefix is configured", async () => {
    env.UGC_UPLOAD_TEST_PREFIX = "production";
    submission({ id: "production", kind: "image", filePath: "production/photo.webp" });
    submission({ id: "test", kind: "image", filePath: "_test/photo.webp" });
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all();
    const response = await request("/test-images", {
      method: "DELETE",
      headers: createReviewerSession("a"),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TEST_PREFIX_DISABLED" });
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all()).toEqual(
      before,
    );
    expect(reviewEvents()).toEqual([]);
  });

  it("archives only test-namespace images and retains their rows, objects and history on repeat cleanup", async () => {
    submission({
      id: "test-active",
      kind: "image",
      filePath: "_test/active.webp",
      moderationNote: "Original review",
    });
    submission({
      id: "test-pending",
      kind: "image",
      filePath: "_test/pending.webp",
      status: "pending_openai",
    });
    submission({
      id: "test-stale",
      kind: "image",
      filePath: "_test/stale.webp",
      status: "stale",
      moderationNote: "Historical archive",
    });
    submission({ id: "production", kind: "image" });
    submission({ id: "similar-prefix", kind: "image", filePath: "xtest/photo.webp" });
    submission({ id: "sibling-prefix", kind: "image", filePath: "_test-other/photo.webp" });
    submission({ id: "comment" });
    const objects = new Set([
      "_test/active.webp",
      "_test/pending.webp",
      "_test/stale.webp",
      "images/production.webp",
    ]);
    env.UGC_BUCKET = {
      delete: async (keys: string | string[]) => {
        for (const key of [keys].flat()) {
          objects.delete(key);
        }
      },
    } as unknown as R2Bucket;
    const headers = createReviewerSession("a");
    const response = await request("/test-images", { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      prefix: "_test",
      archivedRows: 2,
      retainedObjects: true,
      deletedObjects: 0,
      deletedRows: 0,
    });
    expect(storedSubmission("test-active")).toMatchObject({
      status: "stale",
      moderation_note: expect.stringContaining("Original review Archived from the test namespace"),
    });
    expect(storedSubmission("test-pending")).toMatchObject({
      status: "stale",
      file_path: "_test/pending.webp",
    });
    expect(storedSubmission("test-stale")).toMatchObject({
      status: "stale",
      moderation_note: "Historical archive",
    });
    for (const id of ["production", "similar-prefix", "sibling-prefix", "comment"]) {
      expect(storedSubmission(id)).toMatchObject({ status: "active" });
    }
    expect(reviewEvents()).toEqual([
      {
        submission_id: "test-active",
        from_status: "active",
        to_status: "stale",
        source: "manual_moderation",
        ai_reviewed: 0,
      },
      {
        submission_id: "test-pending",
        from_status: "pending_openai",
        to_status: "stale",
        source: "manual_moderation",
        ai_reviewed: 0,
      },
    ]);
    const afterArchive = database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all();
    expect(afterArchive).toHaveLength(7);
    const repeat = await request("/test-images", { method: "DELETE", headers });
    expect(await repeat.json()).toMatchObject({
      archivedRows: 0,
      retainedObjects: true,
      deletedObjects: 0,
      deletedRows: 0,
    });
    const deletion = await request("/stale", { method: "DELETE", headers });
    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toMatchObject({ code: "APPEND_ONLY_RETENTION" });
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all()).toEqual(
      afterArchive,
    );
    expect([...objects].sort()).toEqual([
      "_test/active.webp",
      "_test/pending.webp",
      "_test/stale.webp",
      "images/production.webp",
    ]);
    expect(reviewEvents()).toHaveLength(2);
    expect(authorPoints()).toBe(20);
    expect(notificationMessages()).toEqual([]);
  });

  it("reports unreferenced objects across storage pages while treating archived images as retained references", async () => {
    submission({ id: "visible", kind: "image", filePath: "images/visible.webp" });
    submission({
      id: "archived",
      kind: "image",
      status: "stale",
      filePath: "images/archived.webp",
    });
    submission({
      id: "archived-snapshot",
      kind: "image",
      status: "stale",
      filePath: "images/archived.webp",
    });
    const object = (key: string, size: number, uploaded: string) => ({
      key,
      size,
      uploaded: new Date(uploaded),
      etag: `etag-${key}`,
      storageClass: "Standard",
    });
    const visible = object("images/visible.webp", 10, "2026-09-01T00:00:00Z");
    const archived = object("images/archived.webp", 20, "2026-09-02T00:00:00Z");
    const olderOrphan = object("images/old.webp", 30, "2026-09-03T00:00:00Z");
    const newerOrphan = object("images/new image.webp", 40, "2026-09-04T00:00:00Z");
    env.UGC_BUCKET = {
      list: async ({ cursor }: R2ListOptions) =>
        cursor
          ? { objects: [archived, newerOrphan], truncated: false }
          : { objects: [visible, olderOrphan], truncated: true, cursor: "second-page" },
      head: async (key: string) =>
        key === newerOrphan.key
          ? {
              httpMetadata: { contentType: "image/webp" },
              customMetadata: { sourceMimeType: "image/png", convertedToWebp: "true" },
            }
          : null,
    } as unknown as R2Bucket;
    const response = await request("/images/orphans", { headers: createReviewerSession("a") });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stats: {
        r2ObjectCount: 4,
        r2SizeBytes: 100,
        referencedFileCount: 2,
        orphanObjectCount: 2,
        orphanSizeBytes: 70,
      },
      items: [
        {
          key: "images/new image.webp",
          url: "https://assets.example.test/images/new%20image.webp",
          sizeBytes: 40,
          uploadedAt: "2026-09-04T00:00:00.000Z",
          contentType: "image/webp",
          sourceMimeType: "image/png",
          convertedToWebp: true,
        },
        {
          key: "images/old.webp",
          sizeBytes: 30,
          uploadedAt: "2026-09-03T00:00:00.000Z",
          contentType: null,
          sourceMimeType: null,
          convertedToWebp: false,
        },
      ],
    });
    expect(storedSubmission("archived")).toMatchObject({
      status: "stale",
      file_path: "images/archived.webp",
    });
    expect(reviewEvents()).toEqual([]);
  });

  it("counts covered points separately from image volume and separates production from test images", async () => {
    env.UGC_UPLOAD_TEST_PREFIX = "_test";
    submission({ id: "ore-a", kind: "image", markerId: "ore-one" });
    submission({ id: "ore-b", kind: "image", markerId: "ore-one" });
    submission({ id: "archive", kind: "image", markerId: "archive", status: "flagged" });
    submission({ id: "chest", kind: "image", markerId: "chest-one", status: "remove_request" });
    submission({ id: "pending", kind: "image", markerId: "ore-two", status: "pending_audit" });
    submission({ id: "stale", kind: "image", markerId: "chest-two", status: "stale" });
    submission({ id: "unknown", kind: "image", markerId: "not-in-manifest" });
    submission({ id: "comment", markerId: "ore-two" });
    submission({ id: "test", kind: "image", markerId: "ore-two", filePath: "_test/ore.webp" });
    const headers = createReviewerSession("a");
    const response = await request("/images/coverage", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scope: "prod",
      manifest: { schemaVersion: 1, sourceCommit: "synthetic-coverage-manifest" },
      total: {
        totalPoints: 5,
        coveredPoints: 3,
        missingPoints: 2,
        imageCount: 4,
        coverageRate: 0.6,
      },
      regions: [
        {
          key: "valley",
          totalPoints: 3,
          coveredPoints: 2,
          missingPoints: 1,
          imageCount: 3,
          categories: [
            { key: "collection", totalPoints: 2, coveredPoints: 1, imageCount: 2 },
            { key: "archives", totalPoints: 1, coveredPoints: 1, imageCount: 1 },
          ],
          types: [
            {
              key: "ore",
              totalPoints: 2,
              coveredPoints: 1,
              imageCount: 2,
              missingMarkers: [{ markerId: "ore-two" }],
            },
            { key: "archives", coveredPoints: 1, missingMarkers: [] },
          ],
        },
        {
          key: "ridge",
          totalPoints: 2,
          coveredPoints: 1,
          missingPoints: 1,
          imageCount: 1,
          types: [
            {
              key: "chest",
              missingMarkers: [{ markerId: "chest-two" }],
            },
          ],
        },
      ],
    });
    const test = await request("/images/coverage?scope=test", { headers });
    expect(await test.json()).toMatchObject({
      scope: "test",
      total: {
        totalPoints: 5,
        coveredPoints: 1,
        missingPoints: 4,
        imageCount: 1,
        coverageRate: 0.2,
      },
      regions: [
        {
          key: "valley",
          types: [
            { key: "ore", missingMarkers: [{ markerId: "ore-one" }] },
            {
              key: "archives",
              missingMarkers: [{ markerId: "archive" }],
            },
          ],
        },
        { key: "ridge", coveredPoints: 0 },
      ],
    });
  });

  it("shows public duplicate images in the requested namespace with independent page totals and viewer reactions", async () => {
    const headers = createReviewerSession("p", "reviewer");
    submission({ id: "a-old", kind: "image", markerId: "a", createdAt: "2026-09-01 00:00:00" });
    submission({
      id: "a-new",
      kind: "image",
      markerId: "a",
      status: "flagged",
      createdAt: "2026-09-02 00:00:00",
    });
    submission({
      id: "a-waiting",
      kind: "image",
      markerId: "a",
      status: "pending_audit",
      createdAt: "2026-09-20 00:00:00",
    });
    submission({ id: "a-stale", kind: "image", markerId: "a", status: "stale" });
    submission({ id: "b-old", kind: "image", markerId: "b", createdAt: "2026-09-03 00:00:00" });
    submission({
      id: "b-new",
      kind: "image",
      markerId: "b",
      status: "remove_request",
      createdAt: "2026-09-04 00:00:00",
    });
    submission({ id: "single", kind: "image", markerId: "single" });
    submission({
      id: "single-waiting",
      kind: "image",
      markerId: "single",
      status: "pending_openai",
    });
    submission({ id: "test-one", kind: "image", markerId: "test", filePath: "_test/one.webp" });
    submission({ id: "test-two", kind: "image", markerId: "test", filePath: "_test/two.webp" });
    database.sqlite
      .prepare(
        "INSERT INTO ugc_submission_upvotes (submission_id, user_id) VALUES ('a-old', 'reviewer')",
      )
      .run();
    database.sqlite
      .prepare(
        "INSERT INTO ugc_submission_flags (submission_id, user_id) VALUES ('a-new', 'reviewer')",
      )
      .run();
    const page = await request("/images/duplicates?scope=prod&limit=1&offset=1", { headers });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 1,
      items: [
        {
          markerId: "a",
          imageCount: 2,
          latestImage: {
            id: "a-new",
            status: "flagged",
            flagCount: 1,
            url: "https://assets.example.test/images/a-new.webp",
            author: { nickname: "author", publicUid: "101AA" },
          },
        },
      ],
    });
    const detail = await request("/images/duplicates/a?scope=prod&limit=1&offset=1", { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      markerId: "a",
      total: 2,
      limit: 1,
      offset: 1,
      items: [{ id: "a-old", upvoted: true, flagged: false, upvoteCount: 1 }],
    });
    const single = await request("/images/duplicates/single?scope=prod", { headers });
    expect(await single.json()).toMatchObject({ total: 1, items: [] });
    const test = await request("/images/duplicates?scope=test", { headers });
    expect(await test.json()).toMatchObject({
      total: 1,
      items: [{ markerId: "test", imageCount: 2 }],
    });
    expect(await (await request("/images/duplicates", { headers })).json()).toMatchObject({
      total: 3,
    });
    const localApp = createRoutes().onError(onAppError);
    const local = await localApp.request(
      "http://localhost/images/duplicates?scope=prod",
      { headers },
      env,
    );
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          markerId: "a",
          latestImage: expect.objectContaining({
            url: "http://localhost/uploads/v1/public-file/images/a-new.webp",
          }),
        }),
      ]),
    });
    env.UGC_UPLOAD_TEST_PREFIX = "_test";
    const sandboxed = await request("/images/duplicates?scope=prod", { headers });
    expect(await sandboxed.json()).toMatchObject({ total: 1, items: [{ markerId: "test" }] });
  });

  it("filters review items by status and UTC date range while reporting totals beyond the page limit", async () => {
    submission({
      id: "older-audit",
      status: "pending_audit",
      poiType: "chest",
      createdAt: "2026-09-10 01:00:00",
    });
    submission({
      id: "newer-audit",
      kind: "image",
      status: "pending_audit",
      poiType: "chest",
      createdAt: "2026-09-10 02:00:00",
    });
    submission({
      id: "reported",
      status: "flagged",
      poiType: "archives",
      createdAt: "2026-09-10 03:00:00",
    });
    submission({ id: "outside-dates", status: "pending_audit", createdAt: "2026-09-09 23:59:59" });
    submission({ id: "outside-status", status: "active", createdAt: "2026-09-10 01:00:00" });
    const query = new URLSearchParams({
      status: "pending_audit,flagged,pending_audit",
      from: "2026-09-10T08:00:00+08:00",
      to: "2026-09-11T07:59:59+08:00",
      limit: "1",
    });
    const response = await request(`/pending?${query}`, { headers: createReviewerSession() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ id: string }>;
      limit: number;
      stats: unknown;
    };
    expect(body.items.map((item) => item.id)).toEqual(["older-audit"]);
    expect(body.limit).toBe(1);
    expect(body.stats).toEqual({
      total: 3,
      byKind: [
        { kind: "comment", count: 2 },
        { kind: "image", count: 1 },
      ],
      byType: [
        { type: "chest", count: 2 },
        { type: "archives", count: 1 },
      ],
      byStatus: [
        { status: "flagged", count: 1 },
        { status: "pending_audit", count: 2 },
      ],
    });
  });
});
