import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModerationTestFixture,
  type ModerationTestFixture,
} from "@/test/fixtures/moderation";

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
let moderationMessages: ModerationTestFixture["messages"]["moderation"];
let translationMessages: ModerationTestFixture["messages"]["translation"];
let webhookMessages: ModerationTestFixture["messages"]["webhook"];
let liveMessages: ModerationTestFixture["messages"]["live"];

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
  moderationMessages = fixture.messages.moderation;
  translationMessages = fixture.messages.translation;
  webhookMessages = fixture.messages.webhook;
  liveMessages = fixture.messages.live;
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
    const send = env.OEM_AUTO_MODERATION_Q.send;
    env.OEM_AUTO_MODERATION_Q.send = async () => {
      throw new Error("Queue unavailable");
    };
    const failed = await request("/run", { method: "POST", headers, body: { limit: 1 } });
    expect(failed.status).toBe(500);
    expect(storedSubmission("retry")).toMatchObject({
      status: "pending_openai",
      moderation_queued_at: null,
    });
    expect(moderationMessages).toEqual([]);
    env.OEM_AUTO_MODERATION_Q.send = send;
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

describe("automatic moderation recovery and preserved decisions", () => {
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
});
