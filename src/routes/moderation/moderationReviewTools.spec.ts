import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import {
  createSnapshotModerationFixture,
  type SnapshotModerationFixture,
} from "@/test/fixtures/management";

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

let database: SnapshotModerationFixture["database"];
let env: SnapshotModerationFixture["env"];
let createReviewerSession: SnapshotModerationFixture["createReviewerSession"];
let submission: SnapshotModerationFixture["submission"];
let request: SnapshotModerationFixture["request"];
let storedSubmission: SnapshotModerationFixture["storedSubmission"];
let authorPoints: SnapshotModerationFixture["authorPoints"];
let reviewAudits: SnapshotModerationFixture["reviewAudits"];
let notificationMessages: SnapshotModerationFixture["notificationMessages"];

beforeEach(() => {
  redisCounts.clear();
  const fixture = createSnapshotModerationFixture();
  ({
    database,
    env,
    createReviewerSession,
    submission,
    request,
    storedSubmission,
    authorPoints,
    reviewAudits,
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
    expect(reviewAudits()).toEqual([]);
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
    expect(reviewAudits()).toEqual([]);
  });

  it("archives only test-namespace images and retains their rows, objects and history on repeat cleanup", async () => {
    submission({
      id: "test-active",
      kind: "image",
      filePath: "_test/active.webp",
    });
    submission({
      id: "test-pending",
      kind: "image",
      filePath: "_test/pending.webp",
      reviewStatus: "pending_openai",
    });
    submission({
      id: "test-stale",
      kind: "image",
      filePath: "_test/stale.webp",
      reviewStatus: "unknown",
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
      archivedRows: 3,
      retainedObjects: true,
      deletedObjects: 0,
      deletedRows: 0,
    });
    for (const id of ["test-active", "test-pending", "test-stale"]) {
      expect(storedSubmission(id)).toMatchObject({
        admin_deleted_at: expect.any(String),
        admin_deleted_by: expect.any(String),
      });
    }
    for (const id of ["production", "similar-prefix", "sibling-prefix", "comment"]) {
      expect(storedSubmission(id)).toMatchObject({ admin_deleted_at: null });
    }
    expect(
      database.sqlite
        .prepare(
          "SELECT id,review_status,file_path FROM ugc_snapshots WHERE submission_id LIKE 'test-%' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "snapshot-test-active", review_status: "approved", file_path: "_test/active.webp" },
      {
        id: "snapshot-test-pending",
        review_status: "pending_openai",
        file_path: "_test/pending.webp",
      },
      { id: "snapshot-test-stale", review_status: "unknown", file_path: "_test/stale.webp" },
    ]);
    expect(reviewAudits()).toEqual([]);
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
    expect(reviewAudits()).toHaveLength(0);
    expect(authorPoints()).toBe(20);
    expect(notificationMessages()).toEqual([]);
  });

  it("reports unreferenced objects across storage pages while treating archived images as retained references", async () => {
    submission({ id: "visible", kind: "image", filePath: "images/visible.webp" });
    submission({
      id: "archived",
      kind: "image",
      reviewStatus: "unknown",
      filePath: "images/archived.webp",
    });
    submission({
      id: "archived-snapshot",
      kind: "image",
      reviewStatus: "unknown",
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
    expect(
      database.sqlite
        .prepare("SELECT review_status,file_path FROM ugc_snapshots WHERE submission_id='archived'")
        .get(),
    ).toEqual({ review_status: "unknown", file_path: "images/archived.webp" });
    expect(reviewAudits()).toEqual([]);
  });

  it("counts covered points separately from image volume and separates production from test images", async () => {
    env.UGC_UPLOAD_TEST_PREFIX = "_test";
    submission({ id: "ore-a", kind: "image", markerId: "ore-one" });
    submission({ id: "ore-b", kind: "image", markerId: "ore-one" });
    submission({ id: "archive", kind: "image", markerId: "archive", reviewStatus: "approved" });
    submission({ id: "chest", kind: "image", markerId: "chest-one", reviewStatus: "approved" });
    submission({
      id: "pending",
      kind: "image",
      markerId: "ore-two",
      reviewStatus: "pending_audit",
    });
    submission({ id: "stale", kind: "image", markerId: "chest-two", reviewStatus: "unknown" });
    submission({ id: "unknown", kind: "image", markerId: "not-in-manifest" });
    submission({ id: "comment", markerId: "ore-two" });
    submission({ id: "test", kind: "image", markerId: "ore-two", filePath: "_test/ore.webp" });
    const headers = createReviewerSession("a");
    database.sqlite.exec(
      "INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('archive','author')",
    );
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
      reviewStatus: "approved",
      createdAt: "2026-09-02 00:00:00",
    });
    submission({
      id: "a-waiting",
      kind: "image",
      markerId: "a",
      reviewStatus: "pending_audit",
      createdAt: "2026-09-20 00:00:00",
    });
    submission({ id: "a-stale", kind: "image", markerId: "a", reviewStatus: "unknown" });
    submission({ id: "b-old", kind: "image", markerId: "b", createdAt: "2026-09-03 00:00:00" });
    submission({
      id: "b-new",
      kind: "image",
      markerId: "b",
      reviewStatus: "approved",
      createdAt: "2026-09-04 00:00:00",
    });
    submission({ id: "single", kind: "image", markerId: "single" });
    submission({
      id: "single-waiting",
      kind: "image",
      markerId: "single",
      reviewStatus: "pending_openai",
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
      reviewStatus: "pending_audit",
      poiType: "chest",
      createdAt: "2026-09-10 01:00:00",
    });
    submission({
      id: "newer-audit",
      kind: "image",
      reviewStatus: "pending_audit",
      poiType: "chest",
      createdAt: "2026-09-10 02:00:00",
    });
    submission({
      id: "reported",
      reviewStatus: "approved",
      poiType: "archives",
      createdAt: "2026-09-10 03:00:00",
    });
    submission({
      id: "outside-dates",
      reviewStatus: "pending_audit",
      createdAt: "2026-09-09 23:59:59",
    });
    submission({
      id: "outside-status",
      reviewStatus: "approved",
      createdAt: "2026-09-10 01:00:00",
    });
    createReviewerSession("p", "reporter");
    database.sqlite.exec(
      "INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('reported','reporter')",
    );
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
      byReviewStatus: [
        { reviewStatus: "approved", count: 1 },
        { reviewStatus: "pending_audit", count: 2 },
      ],
    });
  });
});
