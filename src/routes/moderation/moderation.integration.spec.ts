import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, testAuthConfig, type SessionHeaders } from "@/test/fixtures/auth";
import {
  insertSubmission,
  type SeededSubmission,
  type SubmissionFixture,
} from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { Bindings, Role } from "@/types/app";

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

let database: TestDatabase;
let env: Bindings;
let moderationMessages: unknown[];
let translationMessages: unknown[];
let webhookMessages: unknown[];
let liveMessages: Array<{ recipient: string; envelope: unknown }>;

beforeEach(() => {
  database = createTestDatabase();
  redisCounts.clear();
  moderationMessages = [];
  translationMessages = [];
  webhookMessages = [];
  liveMessages = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  insertUser(database.sqlite, { uid: "author", uid_number: 101, points: 20 });
  env = {
    ...testAuthConfig,
    DB: database.db,
    LOCK_MODERATION_ENDPOINTS: "false",
    UGC_UPLOAD_TEST_PREFIX: "",
    UGC_ASSET_BASE_URL: "https://assets.example.test",
    ENABLE_COMMENT_TRANSLATION_PREWARM: "true",
    OEM_AUTH_RATE_LIMIT: { limit: async () => ({ success: true }) },
    OEM_MODERATION_Q: {
      send: async (message: unknown) => {
        moderationMessages.push(message);
      },
    },
    OEM_TRANSLATION_Q: {
      send: async (message: unknown) => {
        translationMessages.push(message);
      },
    },
    OEM_WEBHOOK_Q: {
      send: async (message: unknown) => {
        webhookMessages.push(message);
      },
    },
    OEM_NOTIFICATION_DO: {
      idFromName: (name: string) => name,
      get: (recipient: string) => ({
        fetch: async (_url: string, init: RequestInit) => {
          liveMessages.push({ recipient, envelope: JSON.parse(String(init.body)) });
          return new Response(null, { status: 204 });
        },
      }),
    },
  } as unknown as Bindings;
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

function createReviewerSession(
  role: Role = "p",
  uid: string = crypto.randomUUID(),
): SessionHeaders {
  // Unique users keep the production auth and local rate-limit caches independent.
  const userCount = Number(
    database.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()!.count,
  );
  return insertAuthenticatedUser(database.sqlite, {
    uid,
    uid_number: 1000 + userCount,
    role,
  }).headers;
}

type ModerationSubmissionFixture = Omit<SubmissionFixture, "userId"> & { userId?: string };

function submission(input: ModerationSubmissionFixture): SeededSubmission {
  return insertSubmission(database.sqlite, { userId: "author", ...input });
}

interface ModerationRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

async function request(path: string, options: ModerationRequestOptions = {}): Promise<Response> {
  const app = createRoutes();
  app.onError(onAppError);
  const pending: Promise<unknown>[] = [];
  const response = await app.request(
    `https://api.example.test${path}`,
    {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json", ...options.headers },
      body:
        options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    },
    env,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as ExecutionContext,
  );
  // Complete waitUntil work before asserting queue delivery and live notifications.
  await Promise.all(pending);
  return response;
}

function storedSubmission(id: string) {
  return database.sqlite.prepare("SELECT * FROM ugc_submissions WHERE id = ?").get(id);
}

function authorPoints() {
  return database.sqlite.prepare("SELECT points FROM users WHERE uid = 'author'").get()!.points;
}

function reviewEvents() {
  return database.sqlite
    .prepare(
      "SELECT submission_id, from_status, to_status, source, ai_reviewed FROM ugc_review_events ORDER BY id",
    )
    .all();
}

function notificationMessages() {
  return database.sqlite
    .prepare(`SELECT n.recipient_user_id, n.type, m.submission_id
    FROM notifications n JOIN notification_messages m ON m.notification_id = n.id
    ORDER BY n.recipient_user_id, m.submission_id`)
    .all();
}

describe("moderation recovery and preserved decisions", () => {
  it("rejects invalid moderation operations without changing review history or delivering effects", async () => {
    submission({ id: "waiting", status: "pending_audit" });
    const headers = createReviewerSession("a");
    const before = storedSubmission("waiting");
    for (const [path, method, body] of [
      ["/warnings", "POST", { publicUid: "" }],
      ["/pending?from=invalid", "GET", undefined],
      ["/images/coverage?scope=unknown", "GET", undefined],
      ["/images/duplicates?offset=-1", "GET", undefined],
      ["/images/duplicates/marker?limit=0", "GET", undefined],
      ["/images/duplicates/%20", "GET", undefined],
      ["/waiting/status", "PATCH", { status: "unknown" }],
      ["/run", "POST", { limit: 0 }],
    ] as const) {
      const response = await request(path, { method, headers, body });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(storedSubmission("waiting")).toEqual(before);
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
    expect(notificationMessages()).toEqual([]);
    expect(webhookMessages).toEqual([]);
    expect(translationMessages).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a newer author snapshot when a manual reviewer loses the write race", async () => {
    submission({ id: "changing", status: "pending_audit" });
    database.hooks.beforeQuery = (sql) => {
      if (/UPDATE ugc_submissions\s+SET status/.test(sql)) {
        database.hooks.beforeQuery = undefined;
        database.sqlite.exec(
          "UPDATE ugc_submissions SET snapshot_id='newer', content='New directions' WHERE id='changing'",
        );
      }
    };
    const response = await request("/changing/status", {
      method: "PATCH",
      headers: createReviewerSession(),
      body: { status: "active" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "MODERATION_CONFLICT" });
    expect(storedSubmission("changing")).toMatchObject({
      status: "pending_audit",
      snapshot_id: "newer",
      content: "New directions",
    });
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
    expect(notificationMessages()).toEqual([]);
    expect(translationMessages).toEqual([]);
    expect(liveMessages).toEqual([]);
  });

  it.each(["network", "http"])(
    "keeps an image approval after an asset prewarm %s failure",
    async (failure) => {
      submission({ id: "photo", kind: "image", status: "pending_audit" });
      vi.mocked(fetch).mockImplementation(async () => {
        if (failure === "network") {
          throw new Error("asset edge unavailable");
        }
        return new Response(null, { status: 503 });
      });
      const response = await request("/photo/status", {
        method: "PATCH",
        headers: createReviewerSession(),
        body: { status: "active" },
      });
      expect(response.status).toBe(200);
      expect(storedSubmission("photo")).toMatchObject({ status: "active" });
      expect(authorPoints()).toBe(26);
      expect(notificationMessages()).toEqual([
        expect.objectContaining({ recipient_user_id: "author", submission_id: "photo" }),
      ]);
      expect(fetch).toHaveBeenCalledWith(
        "https://assets.example.test/images/photo.webp",
        expect.objectContaining({ method: "GET" }),
      );
    },
  );

  it.each([
    { previousStatus: "active", expectedPoints: 20 },
    { previousStatus: "pending_audit", expectedPoints: 22 },
  ])(
    "approves an edit formerly $previousStatus with $expectedPoints author points and prewarm disabled",
    async ({ previousStatus, expectedPoints }) => {
      env.OPENAI_API_KEY = "synthetic-ai-key";
      env.ENABLE_COMMENT_TRANSLATION_PREWARM = "false";
      submission({
        id: "edited",
        status: "pending_openai",
        moderationNote: "Edited by author: correction",
      });
      database.sqlite
        .prepare(
          `UPDATE ugc_submissions SET edit_original_content='Original directions', edit_original_status=?, edit_original_snapshot_id='previous' WHERE id='edited'`,
        )
        .run(previousStatus);
      vi.mocked(fetch).mockResolvedValue(Response.json({ results: [{ flagged: false }] }));
      const response = await request("/run", {
        method: "POST",
        headers: createReviewerSession("a"),
        body: { ids: ["edited"] },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ processed: 1, active: 1 });
      expect(storedSubmission("edited")).toMatchObject({
        status: "active",
        edit_original_status: null,
      });
      // Only the first approval earns points; editing approved content cannot earn them again.
      expect(authorPoints()).toBe(expectedPoints);
      expect(translationMessages).toEqual([]);
      expect(notificationMessages()).toHaveLength(1);
    },
  );

  it("rejects malformed status JSON without changing the submission and permits a later decision", async () => {
    submission({ id: "waiting", status: "pending_audit" });
    const headers = createReviewerSession("a");
    const before = storedSubmission("waiting");
    const response = await request("/waiting/status", { method: "PATCH", headers, rawBody: "{" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(storedSubmission("waiting")).toEqual(before);
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
    expect(notificationMessages()).toEqual([]);
    expect(
      (await request("/waiting/status", { method: "PATCH", headers, body: { status: "active" } }))
        .status,
    ).toBe(200);
    expect(storedSubmission("waiting")).toMatchObject({ status: "active" });
  });
});

describe("moderation access", () => {
  it("requires a session before reading or changing submissions", async () => {
    submission({ id: "waiting", status: "pending_audit" });
    for (const response of [
      await request("/pending"),
      await request("/waiting/status", { method: "PATCH", body: { status: "active" } }),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
    }
    expect(storedSubmission("waiting")).toMatchObject({ status: "pending_audit" });
    expect(reviewEvents()).toEqual([]);
  });

  it.each([
    { role: "n", review: 403, run: 403 },
    { role: "s", review: 403, run: 403 },
    { role: "p", review: 200, run: 403 },
    { role: "a", review: 200, run: 200 },
    { role: "r", review: 200, run: 200 },
  ] as const)(
    "gives role $role its review and automatic-run permissions",
    async ({ role, review, run }) => {
      const headers = createReviewerSession(role);
      submission({ id: "waiting", status: "pending_audit" });
      expect((await request("/pending", { headers })).status).toBe(review);
      expect(
        (
          await request("/waiting/status", {
            method: "PATCH",
            headers,
            body: { status: "active" },
          })
        ).status,
      ).toBe(review);
      expect((await request("/run", { method: "POST", headers, body: {} })).status).toBe(run);
      expect(storedSubmission("waiting")).toMatchObject({
        status: review === 200 ? "active" : "pending_audit",
      });
      expect(authorPoints()).toBe(review === 200 ? 22 : 20);
    },
  );

  it.each([
    ["/images/coverage", "GET"],
    ["/images/orphans", "GET"],
    ["/warnings", "POST"],
    ["/run-once", "POST"],
    ["/karma/run-once", "POST"],
    ["/test-images", "DELETE"],
    ["/stale", "DELETE"],
  ])("reserves %s for administrators", async (path, method) => {
    const response = await request(path, {
      method,
      headers: createReviewerSession("p"),
      body: method === "POST" ? {} : undefined,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("keeps review and mutation endpoints locked by default, including for administrators", async () => {
    delete env.LOCK_MODERATION_ENDPOINTS;
    const headers = createReviewerSession("a");
    submission({ id: "waiting", status: "pending_audit" });
    for (const [path, method, body] of [
      ["/pending", "GET", undefined],
      ["/waiting/status", "PATCH", { status: "active" }],
      ["/run", "POST", { ids: ["waiting"] }],
    ] as const) {
      const response = await request(path, { method, headers, body });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "MODERATION_TEMPORARILY_DISABLED" });
    }
    expect(storedSubmission("waiting")).toMatchObject({ status: "pending_audit" });
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
    expect(webhookMessages).toEqual([]);
    expect(moderationMessages).toEqual([]);
  });
});

describe("automatic moderation", () => {
  it.each(["stored image", "public fallback"])(
    "reviews a %s and rewards the image author",
    async (source) => {
      env.OPENAI_API_KEY = "synthetic-ai-key";
      submission({ id: "photo", kind: "image", content: null, status: "pending_openai" });
      env.UGC_BUCKET = {
        get: async () =>
          source === "stored image"
            ? {
                httpMetadata: { contentType: "image/png" },
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
              }
            : null,
      } as unknown as R2Bucket;
      const aiInputs: unknown[] = [];
      const warmedAssets: string[] = [];
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url) === "https://api.openai.com/v1/moderations") {
          aiInputs.push(JSON.parse(String(init?.body)).input);
          return Response.json({ results: [{ flagged: false }] });
        }
        warmedAssets.push(String(url));
        return new Response("image");
      });
      const response = await request("/run", {
        method: "POST",
        headers: createReviewerSession("a"),
        body: { ids: ["photo"] },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ processed: 1, active: 1 });
      expect(aiInputs).toEqual([
        [
          {
            type: "image_url",
            image_url: {
              url:
                source === "stored image"
                  ? "data:image/png;base64,AQID"
                  : "https://assets.example.test/images/photo.webp",
            },
          },
        ],
      ]);
      expect(warmedAssets).toEqual(["https://assets.example.test/images/photo.webp"]);
      expect(storedSubmission("photo")).toMatchObject({ status: "active" });
      expect(authorPoints()).toBe(26);
      expect(translationMessages).toEqual([]);
      expect(notificationMessages()).toEqual([
        { recipient_user_id: "author", type: "system.submission.approved", submission_id: "photo" },
      ]);
    },
  );

  it("keeps a failed queue send eligible for the next backfill", async () => {
    submission({ id: "retry", status: "pending_openai" });
    const headers = createReviewerSession("a");
    const send = env.OEM_MODERATION_Q.send;
    env.OEM_MODERATION_Q.send = async () => {
      throw new Error("Queue unavailable");
    };
    const failed = await request("/run", { method: "POST", headers, body: { limit: 1 } });
    expect(failed.status).toBe(500);
    expect(storedSubmission("retry")).toMatchObject({
      status: "pending_openai",
      moderation_queued_at: null,
    });
    expect(moderationMessages).toEqual([]);
    env.OEM_MODERATION_Q.send = send;
    const retry = await request("/run", { method: "POST", headers, body: { limit: 1 } });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ enqueued: 1 });
    expect(moderationMessages).toEqual([
      expect.objectContaining({ submissionId: "retry", snapshotId: "snapshot-retry" }),
    ]);
    expect(storedSubmission("retry")).toMatchObject({
      status: "pending_openai",
      moderation_queued_at: expect.any(String),
    });
    expect(reviewEvents()).toEqual([]);
    expect(authorPoints()).toBe(20);
  });

  it("backfills the oldest pending snapshots within the limit and retries only expired queue reservations", async () => {
    const oldReservation = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const freshReservation = new Date().toISOString();
    submission({ id: "oldest", status: "pending_openai", createdAt: "2026-09-01 00:00:00" });
    submission({ id: "expired", status: "pending_openai", createdAt: "2026-09-02 00:00:00" });
    submission({ id: "fresh", status: "pending_openai", createdAt: "2026-09-03 00:00:00" });
    submission({ id: "human-review", status: "pending_audit" });
    submission({ id: "approved", status: "active" });
    database.sqlite
      .prepare("UPDATE ugc_submissions SET moderation_queued_at = ? WHERE id = 'expired'")
      .run(oldReservation);
    database.sqlite
      .prepare("UPDATE ugc_submissions SET moderation_queued_at = ? WHERE id = 'fresh'")
      .run(freshReservation);
    const headers = createReviewerSession("a");
    const first = await request("/run", { method: "POST", headers, body: { limit: 1 } });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      mode: "queue",
      requested: 1,
      enqueued: 1,
      processed: 0,
      active: 0,
      pendingAudit: 0,
      stale: 0,
    });
    expect(moderationMessages).toEqual([
      expect.objectContaining({
        type: "moderation",
        submissionId: "oldest",
        snapshotId: "snapshot-oldest",
        source: "scheduled_backfill",
      }),
    ]);
    const second = await request("/run-once", { method: "POST", headers });
    expect(await second.json()).toMatchObject({
      mode: "queue",
      enqueued: 1,
      processed: 0,
    });
    expect(moderationMessages).toEqual([
      expect.objectContaining({ submissionId: "oldest" }),
      expect.objectContaining({
        submissionId: "expired",
        snapshotId: "snapshot-expired",
        source: "scheduled_backfill",
      }),
    ]);
    expect(storedSubmission("oldest")).toMatchObject({
      status: "pending_openai",
      moderation_queued_at: expect.any(String),
    });
    expect(storedSubmission("expired")).toMatchObject({
      status: "pending_openai",
      moderation_queued_at: expect.any(String),
    });
    expect(storedSubmission("expired")!.moderation_queued_at).not.toBe(oldReservation);
    expect(storedSubmission("fresh")!.moderation_queued_at).toBe(freshReservation);
    const repeat = await request("/run-once", { method: "POST", headers });
    expect(await repeat.json()).toMatchObject({ enqueued: 0 });
    expect(moderationMessages).toHaveLength(2);
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
    expect(notificationMessages()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a newer author edit pending when an AI decision for the old snapshot arrives", async () => {
    env.OPENAI_API_KEY = "synthetic-ai-key";
    submission({ id: "changing", status: "pending_openai", content: "Original directions" });
    vi.mocked(fetch).mockImplementation(async () => {
      database.sqlite
        .prepare(
          "UPDATE ugc_submissions SET snapshot_id = 'new-snapshot', content = 'Corrected directions' WHERE id = 'changing'",
        )
        .run();
      return Response.json({ results: [{ flagged: false }] });
    });
    const response = await request("/run", {
      method: "POST",
      headers: createReviewerSession("a"),
      body: { ids: ["changing"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 0, active: 0, pendingAudit: 0 });
    expect(storedSubmission("changing")).toMatchObject({
      snapshot_id: "new-snapshot",
      content: "Corrected directions",
      status: "pending_openai",
    });
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
    expect(notificationMessages()).toEqual([]);
    expect(liveMessages).toEqual([]);
    expect(translationMessages).toEqual([]);
    expect(webhookMessages).toEqual([]);
  });

  it.each([
    {
      name: "AI disabled even with local approval enabled",
      settings: {
        SKIP_AI_MODERATION: "true",
        OPENAI_API_KEY: "synthetic-ai-key",
        LOCAL_UPLOAD_AUTO_APPROVE: "true",
      },
      status: "pending_audit",
      points: 20,
    },
    { name: "no AI credentials", settings: {}, status: "pending_audit", points: 20 },
    {
      name: "explicit local approval without credentials",
      settings: { LOCAL_UPLOAD_AUTO_APPROVE: "true" },
      status: "active",
      points: 22,
    },
  ])("records $name as a decision made without AI", async ({ settings, status, points }) => {
    Object.assign(env, settings);
    submission({ id: "local", status: "pending_openai" });
    const response = await request("/run", {
      method: "POST",
      headers: createReviewerSession("a"),
      body: { ids: ["local"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      processed: 1,
      active: status === "active" ? 1 : 0,
      pendingAudit: status === "pending_audit" ? 1 : 0,
    });
    expect(storedSubmission("local")).toMatchObject({ status });
    expect(authorPoints()).toBe(points);
    expect(reviewEvents()).toEqual([
      {
        submission_id: "local",
        from_status: "pending_openai",
        to_status: status,
        source: "auto_moderation",
        ai_reviewed: 0,
      },
    ]);
    expect(notificationMessages()).toEqual([
      {
        recipient_user_id: "author",
        type: status === "active" ? "system.submission.approved" : "system.submission.needs_review",
        submission_id: "local",
      },
    ]);
    expect(liveMessages).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "flagged content",
      result: () => Response.json({ results: [{ flagged: true, categories: { violence: true } }] }),
      reason: "violence",
    },
    {
      name: "no explicit AI decision",
      result: () => Response.json({ results: [] }),
      reason: "no explicit decision",
    },
    {
      name: "provider outage",
      result: () => new Response("Service unavailable", { status: 503 }),
      reason: "unavailable (503",
    },
    {
      name: "network failure",
      result: () => {
        throw new Error("Connection closed");
      },
      reason: "Connection closed",
    },
  ])("sends $name to manual audit without a rejection penalty", async ({ result, reason }) => {
    env.OPENAI_API_KEY = "synthetic-ai-key";
    submission({ id: "uncertain", status: "pending_openai" });
    vi.mocked(fetch).mockImplementation(async () => result());
    const response = await request("/run", {
      method: "POST",
      headers: createReviewerSession("a"),
      body: { ids: ["uncertain"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      processed: 1,
      active: 0,
      pendingAudit: 1,
      stale: 0,
    });
    expect(storedSubmission("uncertain")).toMatchObject({
      status: "pending_audit",
      moderation_note: expect.stringContaining(reason),
    });
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([
      {
        submission_id: "uncertain",
        from_status: "pending_openai",
        to_status: "pending_audit",
        source: "auto_moderation",
        ai_reviewed: 1,
      },
    ]);
    expect(notificationMessages()).toEqual([
      {
        recipient_user_id: "author",
        type: "system.submission.needs_review",
        submission_id: "uncertain",
      },
    ]);
    expect(liveMessages).toEqual([expect.objectContaining({ recipient: "author" })]);
    expect(translationMessages).toEqual([]);
    expect(webhookMessages).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ nextStatus: "pending_audit" }) }),
    ]);
  });

  it("approves a clean comment once and delivers the persisted approval to its author", async () => {
    env.OPENAI_API_KEY = "synthetic-ai-key";
    submission({ id: "clean", status: "pending_openai", content: "Turn left at the bridge" });
    const aiInputs: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/moderations");
      aiInputs.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [{ flagged: false, categories: {} }] });
    });
    const headers = createReviewerSession("a");
    const response = await request("/run", {
      method: "POST",
      headers,
      body: { ids: ["clean", "clean", "missing"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      mode: "selected",
      requested: 3,
      processed: 1,
      active: 1,
      pendingAudit: 0,
      stale: 0,
    });
    expect(aiInputs).toEqual([
      expect.objectContaining({
        input: [{ type: "text", text: "Turn left at the bridge" }],
      }),
    ]);
    expect(storedSubmission("clean")).toMatchObject({
      status: "active",
    });
    expect(authorPoints()).toBe(22);
    expect(reviewEvents()).toEqual([
      {
        submission_id: "clean",
        from_status: "pending_openai",
        to_status: "active",
        source: "auto_moderation",
        ai_reviewed: 1,
      },
    ]);
    expect(notificationMessages()).toEqual([
      { recipient_user_id: "author", type: "system.submission.approved", submission_id: "clean" },
    ]);
    expect(liveMessages).toEqual([
      {
        recipient: "author",
        envelope: expect.objectContaining({
          event: "notification.upserted",
          notification: expect.objectContaining({
            type: "system.submission.approved",
            target: expect.objectContaining({ submissionId: "clean" }),
          }),
          unread: { system: 1, community: 0, total: 1 },
        }),
      },
    ]);
    expect(translationMessages).toEqual([
      expect.objectContaining({ submissionId: "clean", source: "auto_moderation" }),
    ]);
    expect(webhookMessages).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ nextStatus: "active", source: "auto_moderation" }),
      }),
    ]);
    const repeat = await request("/run", { method: "POST", headers, body: { ids: ["clean"] } });
    expect(await repeat.json()).toMatchObject({ processed: 0, active: 0 });
    expect(authorPoints()).toBe(22);
    expect(reviewEvents()).toHaveLength(1);
    expect(aiInputs).toHaveLength(1);
    expect(notificationMessages()).toHaveLength(1);
    expect(liveMessages).toHaveLength(1);
    expect(translationMessages).toHaveLength(1);
    expect(webhookMessages).toHaveLength(1);
  });
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

describe("manual moderation", () => {
  it.each([
    [false, 25],
    [true, 26],
  ] as const)(
    "applies surge mode %s to daily approval rewards without scoring retries again",
    async (surge, expectedPoints) => {
      env.SURGE_MODE_ENABLED = String(surge);
      env.SURGE_BACKOFF_MULTIPLIER = "3";
      const headers = createReviewerSession();
      for (let index = 0; index < 5; index++) {
        const id = `approved-${index}`;
        submission({ id, status: "pending_audit" });
        const options = { method: "PATCH", headers, body: { status: "active" } };
        expect((await request(`/${id}/status`, options)).status).toBe(200);
        expect((await request(`/${id}/status`, options)).status).toBe(200);
      }
      expect(authorPoints()).toBe(expectedPoints);
      expect(reviewEvents()).toHaveLength(5);
      expect(notificationMessages()).toHaveLength(5);
    },
  );
  it("reduces repeated daily rewards independently for comments and images, and warms approved images", async () => {
    const warmedAssets: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      warmedAssets.push(String(input));
      return new Response("image");
    });
    const headers = createReviewerSession();
    // This fixture policy gives 2 then 1 points for comments, and 6 then 5 for
    // images. A comment approval must not consume the image reward counter.
    for (const [id, kind, points] of [
      ["comment-one", "comment", 22],
      ["comment-two", "comment", 23],
      ["image-one", "image", 29],
      ["image-two", "image", 34],
    ] as const) {
      submission({ id, kind, status: "pending_audit" });
      expect(
        (await request(`/${id}/status`, { method: "PATCH", headers, body: { status: "active" } }))
          .status,
      ).toBe(200);
      expect(authorPoints()).toBe(points);
    }
    expect(warmedAssets.sort()).toEqual([
      "https://assets.example.test/images/image-one.webp",
      "https://assets.example.test/images/image-two.webp",
    ]);
    expect(translationMessages).toEqual([
      expect.objectContaining({ submissionId: "comment-one" }),
      expect.objectContaining({ submissionId: "comment-two" }),
    ]);
  });

  it.each(["active", "stale"])(
    "reviews an edit of an approved comment as %s without scoring it again",
    async (status) => {
      submission({
        id: "edited",
        status: "pending_openai",
        content: "Updated directions",
        moderationNote: "Edited by author: correction",
      });
      database.sqlite
        .prepare(`UPDATE ugc_submissions SET edit_original_content = 'Old directions',
      edit_original_status = 'active', edit_original_snapshot_id = 'original-snapshot' WHERE id = 'edited'`)
        .run();
      const response = await request("/edited/status", {
        method: "PATCH",
        headers: createReviewerSession(),
        body: { status },
      });
      expect(response.status).toBe(200);
      expect(storedSubmission("edited")).toMatchObject({ status, content: "Updated directions" });
      expect(authorPoints()).toBe(20);
      expect(reviewEvents()).toHaveLength(1);
      if (status === "active") {
        expect(storedSubmission("edited")).toMatchObject({
          edit_original_content: null,
          edit_original_status: null,
          edit_original_snapshot_id: null,
        });
        expect(translationMessages).toEqual([expect.objectContaining({ submissionId: "edited" })]);
      }
    },
  );

  it("archives an uploader recall without charging a rejection penalty, including a repeat request", async () => {
    // The recall note distinguishes the author's withdrawal from a moderator rejection.
    submission({
      id: "recalled",
      status: "remove_request",
      moderationNote: "Recalled by uploader: outdated directions",
    });
    const headers = createReviewerSession();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (await request("/recalled/status", { method: "PATCH", headers, body: { status: "stale" } }))
          .status,
      ).toBe(200);
    }
    expect(storedSubmission("recalled")).toMatchObject({
      status: "stale",
      moderation_note: "Recalled by uploader: outdated directions",
    });
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toHaveLength(1);
    expect(notificationMessages()).toEqual([
      {
        recipient_user_id: "author",
        type: "system.remove_request.resolved",
        submission_id: "recalled",
      },
    ]);
    expect(translationMessages).toEqual([]);
    expect(webhookMessages).toEqual([]);
  });

  it("clears reports when restoring a flagged submission while preserving reports on other submissions", async () => {
    insertUser(database.sqlite, { uid: "reporter", uid_number: 106 });
    submission({ id: "restored", status: "flagged" });
    submission({ id: "still-reported", status: "flagged" });
    database.sqlite
      .prepare("INSERT INTO ugc_submission_flags (submission_id, user_id) VALUES (?, 'reporter')")
      .run("restored");
    database.sqlite
      .prepare("INSERT INTO ugc_submission_flags (submission_id, user_id) VALUES (?, 'reporter')")
      .run("still-reported");
    const headers = createReviewerSession();
    expect(
      (await request("/restored/status", { method: "PATCH", headers, body: { status: "active" } }))
        .status,
    ).toBe(200);
    const response = await request("/pending?status=active,flagged", { headers });
    const body = (await response.json()) as {
      items: Array<{ id: string; status: string; flagCount: number }>;
    };
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "restored", status: "active", flagCount: 0 }),
        expect.objectContaining({ id: "still-reported", status: "flagged", flagCount: 1 }),
      ]),
    );
    expect(authorPoints()).toBe(22);
    expect(notificationMessages()).toEqual([
      {
        recipient_user_id: "author",
        type: "system.submission.approved",
        submission_id: "restored",
      },
    ]);
  });

  it.each([
    ["active", "pending_audit"],
    ["pending_audit", "pending_openai"],
    ["flagged", "remove_request"],
    ["stale", "pending_audit"],
  ])("rejects %s to %s without altering the submission or its author", async (from, to) => {
    submission({ id: "reviewed", status: from, moderationNote: "Existing review" });
    const before = storedSubmission("reviewed");
    const response = await request("/reviewed/status", {
      method: "PATCH",
      headers: createReviewerSession(),
      body: { status: to, moderationNote: "New review" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
    expect(storedSubmission("reviewed")).toEqual(before);
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
    expect(notificationMessages()).toEqual([]);
    expect(translationMessages).toEqual([]);
    expect(webhookMessages).toEqual([]);
  });

  it("reports a missing submission without creating a review", async () => {
    const response = await request("/missing/status", {
      method: "PATCH",
      headers: createReviewerSession(),
      body: { status: "active" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
    expect(reviewEvents()).toEqual([]);
  });

  it.each([
    ["pending_openai", "pending_audit", 20, "system.submission.needs_review"],
    ["pending_openai", "active", 22, "system.submission.approved"],
    ["pending_openai", "stale", 14, null],
    ["pending_audit", "stale", 14, null],
    ["active", "stale", 14, null],
    ["flagged", "stale", 14, null],
    ["remove_request", "active", 22, "system.remove_request.resolved"],
    ["remove_request", "stale", 14, "system.remove_request.resolved"],
    ["stale", "active", 22, "system.submission.approved"],
  ])(
    "allows %s to %s with its review, points and notification outcome",
    async (from, to, points, notificationType) => {
      submission({ id: "reviewed", status: String(from) });
      const response = await request("/reviewed/status", {
        method: "PATCH",
        headers: createReviewerSession(),
        body: { status: to },
      });
      expect(response.status).toBe(200);
      expect(storedSubmission("reviewed")).toMatchObject({ status: to });
      expect(authorPoints()).toBe(points);
      expect(reviewEvents()).toEqual([
        {
          submission_id: "reviewed",
          from_status: from,
          to_status: to,
          source: "manual_moderation",
          ai_reviewed: 0,
        },
      ]);
      expect(notificationMessages()).toEqual(
        notificationType
          ? [{ recipient_user_id: "author", type: notificationType, submission_id: "reviewed" }]
          : [],
      );
    },
  );

  it("approves a reply, rewards its author once, and notifies the author and parent author once", async () => {
    insertUser(database.sqlite, { uid: "parent-author", uid_number: 105 });
    submission({ id: "parent", userId: "parent-author" });
    submission({ id: "reply", parentId: "parent", depth: 1, status: "pending_audit" });
    const headers = createReviewerSession();

    const response = await request("/reply/status", {
      method: "PATCH",
      headers,
      body: { status: "active", moderationNote: "Useful directions" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(storedSubmission("reply")).toMatchObject({
      status: "active",
      moderation_note: "Useful directions",
    });
    expect(authorPoints()).toBe(22);
    expect(reviewEvents()).toEqual([
      {
        submission_id: "reply",
        from_status: "pending_audit",
        to_status: "active",
        source: "manual_moderation",
        ai_reviewed: 0,
      },
    ]);
    expect(notificationMessages()).toEqual([
      { recipient_user_id: "author", type: "system.submission.approved", submission_id: "reply" },
      {
        recipient_user_id: "parent-author",
        type: "community.comment.reply",
        submission_id: "reply",
      },
    ]);
    expect(liveMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: "author",
          envelope: expect.objectContaining({ unread: { system: 1, community: 0, total: 1 } }),
        }),
        expect.objectContaining({
          recipient: "parent-author",
          envelope: expect.objectContaining({ unread: { system: 0, community: 1, total: 1 } }),
        }),
      ]),
    );
    expect(translationMessages).toEqual([
      expect.objectContaining({
        type: "comment_translation_prewarm",
        submissionId: "reply",
        source: "manual_moderation",
      }),
    ]);
    expect(webhookMessages).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          previousStatus: "pending_audit",
          nextStatus: "active",
          source: "manual_moderation",
        }),
      }),
    ]);

    expect(
      (
        await request("/reply/status", {
          method: "PATCH",
          headers,
          body: { status: "active" },
        })
      ).status,
    ).toBe(200);
    expect(authorPoints()).toBe(22);
    expect(reviewEvents()).toHaveLength(1);
    expect(notificationMessages()).toHaveLength(2);
    expect(liveMessages).toHaveLength(2);
    expect(translationMessages).toHaveLength(1);
    expect(webhookMessages).toHaveLength(1);
  });
});
