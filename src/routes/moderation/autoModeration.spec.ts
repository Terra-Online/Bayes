import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendCommentVersion } from "@/repositories/submission/appendCommentVersion";
import { getReviewTarget, reviewSnapshot } from "@/repositories/submission/reviewSnapshot";
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
let storedSnapshot: ModerationTestFixture["storedSnapshot"];
let authorPoints: ModerationTestFixture["authorPoints"];
let reviewAudits: ModerationTestFixture["reviewAudits"];
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
    storedSnapshot,
    authorPoints,
    reviewAudits,
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
      expect(storedSnapshot("photo")).toMatchObject({ review_status: "approved" });
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
    expect(storedSnapshot("retry")).toMatchObject({
      review_status: "pending_openai",
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
    expect(storedSnapshot("retry")).toMatchObject({
      review_status: "pending_openai",
      moderation_queued_at: expect.any(String),
    });
    expect(reviewAudits()).toEqual([]);
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
      .prepare("UPDATE ugc_snapshots SET moderation_queued_at = ? WHERE submission_id = 'expired'")
      .run(oldReservation);
    database.sqlite
      .prepare("UPDATE ugc_snapshots SET moderation_queued_at = ? WHERE submission_id = 'fresh'")
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
    expect(storedSnapshot("oldest")).toMatchObject({
      review_status: "pending_openai",
      moderation_queued_at: expect.any(String),
    });
    expect(storedSnapshot("expired")).toMatchObject({
      review_status: "pending_openai",
      moderation_queued_at: expect.any(String),
    });
    expect(storedSnapshot("expired")!.moderation_queued_at).not.toBe(oldReservation);
    expect(storedSnapshot("fresh")!.moderation_queued_at).toBe(freshReservation);
    const repeat = await request("/run-once", { method: "POST", headers });
    expect(await repeat.json()).toMatchObject({ enqueued: 0 });
    expect(moderationMessages).toHaveLength(2);
    expect(authorPoints()).toBe(20);
    expect(reviewAudits()).toEqual([]);
    expect(notificationMessages()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a manual takeover when an approval for the same snapshot arrives late", async () => {
    env.OPENAI_API_KEY = "synthetic-ai-key";
    submission({ id: "taken-over", status: "pending_openai" });
    const headers = createReviewerSession("a");
    vi.mocked(fetch).mockImplementation(async () => {
      const takeover = await request("/taken-over/status", {
        method: "PATCH",
        headers,
        body: {
          action: "send_to_manual",
          snapshotId: "snapshot-taken-over",
          expectedReviewStatus: "pending_openai",
          note: "Needs a human decision",
        },
      });
      expect(takeover.status).toBe(200);
      return Response.json({ results: [{ flagged: false }] });
    });
    const response = await request("/run", {
      method: "POST",
      headers,
      body: { ids: ["taken-over"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 0, active: 0, pendingAudit: 0 });
    expect(storedSnapshot("taken-over")).toMatchObject({
      id: "snapshot-taken-over",
      review_status: "pending_audit",
    });
    expect(database.sqlite.prepare("SELECT note FROM ugc_snapshots_review_audit").get()).toEqual({
      note: "Needs a human decision",
    });
    expect(authorPoints()).toBe(20);
    expect(reviewAudits()).toEqual([
      {
        submission_id: "taken-over",
        from_status: "pending_openai",
        to_status: "pending_audit",
        source: "admin",
      },
    ]);
    expect(notificationMessages()).toEqual([
      {
        recipient_user_id: "author",
        type: "system.submission.needs_review",
        submission_id: "taken-over",
      },
    ]);
    expect(liveMessages).toHaveLength(1);
    expect(translationMessages).toEqual([]);
    expect(webhookMessages).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          source: "manual_moderation",
          nextStatus: "pending_audit",
        }),
      }),
    ]);
  });

  it("leaves a newer author edit pending when an AI decision for the old snapshot arrives", async () => {
    env.OPENAI_API_KEY = "synthetic-ai-key";
    submission({ id: "changing", status: "pending_openai", content: "Original directions" });
    createReviewerSession("a", "race-admin");
    vi.mocked(fetch).mockImplementation(async () => {
      await reviewSnapshot(database.db, {
        target: (await getReviewTarget(database.db, "changing"))!,
        expectedReviewStatus: "pending_openai",
        source: "admin",
        adminUserId: "race-admin",
        decision: "approved",
        auditId: "manual-first",
      });
      expect(
        await appendCommentVersion(database.db, {
          submissionId: "changing",
          parentSnapshotId: "snapshot-changing",
          snapshotId: "new-snapshot",
          actorId: "author",
          content: "Corrected directions",
        }),
      ).toMatchObject({ outcome: "appended" });
      return Response.json({ results: [{ flagged: false }] });
    });
    const response = await request("/run", {
      method: "POST",
      headers: createReviewerSession("a"),
      body: { ids: ["changing"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 0, active: 0, pendingAudit: 0 });
    expect(storedSnapshot("changing")).toMatchObject({
      id: "new-snapshot",
      content: "Corrected directions",
      review_status: "pending_openai",
    });
    expect(authorPoints()).toBe(20);
    expect(reviewAudits()).toEqual([
      {
        submission_id: "changing",
        from_status: "pending_openai",
        to_status: "approved",
        source: "admin",
      },
    ]);
    expect(notificationMessages()).toHaveLength(1);
    expect(liveMessages).toEqual([]);
    expect(translationMessages).toEqual([]);
    expect(webhookMessages).toEqual([]);
  });

  it.each([
    {
      name: "AI disabled even with local approval enabled",
      reason: "AI moderation skipped; waiting for manual audit.",
      settings: {
        SKIP_AI_MODERATION: "true",
        OPENAI_API_KEY: "synthetic-ai-key",
        LOCAL_UPLOAD_AUTO_APPROVE: "true",
      },
      status: "pending_audit",
      points: 20,
    },
    {
      name: "no AI credentials",
      settings: {},
      status: "pending_audit",
      points: 20,
      reason: "OpenAI moderation skipped in local mode; waiting for manual audit.",
    },
    {
      name: "explicit local approval without credentials",
      reason: "Local upload debug auto-approved (OPENAI_API_KEY missing).",
      settings: { LOCAL_UPLOAD_AUTO_APPROVE: "true" },
      status: "active",
      points: 22,
    },
  ])(
    "records $name as a decision made without AI",
    async ({ settings, status, points, reason }) => {
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
      expect(storedSnapshot("local")).toMatchObject({
        review_status: status === "active" ? "approved" : status,
      });
      expect(database.sqlite.prepare("SELECT note FROM ugc_snapshots_review_audit").get()).toEqual({
        note: reason,
      });
      expect(authorPoints()).toBe(points);
      expect(reviewAudits()).toEqual([
        {
          submission_id: "local",
          from_status: "pending_openai",
          to_status: status === "active" ? "approved" : status,
          source: "ai",
        },
      ]);
      expect(notificationMessages()).toEqual([
        {
          recipient_user_id: "author",
          type:
            status === "active" ? "system.submission.approved" : "system.submission.needs_review",
          submission_id: "local",
        },
      ]);
      expect(liveMessages).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

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
    expect(storedSnapshot("uncertain")).toMatchObject({
      review_status: "pending_audit",
    });
    expect(database.sqlite.prepare("SELECT note FROM ugc_snapshots_review_audit").get()).toEqual({
      note: expect.stringContaining(reason),
    });
    expect(authorPoints()).toBe(20);
    expect(reviewAudits()).toEqual([
      {
        submission_id: "uncertain",
        from_status: "pending_openai",
        to_status: "pending_audit",
        source: "ai",
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
    expect(storedSnapshot("clean")).toMatchObject({
      review_status: "approved",
    });
    expect(authorPoints()).toBe(22);
    expect(reviewAudits()).toEqual([
      {
        submission_id: "clean",
        from_status: "pending_openai",
        to_status: "approved",
        source: "ai",
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
    expect(reviewAudits()).toHaveLength(1);
    expect(aiInputs).toHaveLength(1);
    expect(notificationMessages()).toHaveLength(1);
    expect(liveMessages).toHaveLength(1);
    expect(translationMessages).toHaveLength(1);
    expect(webhookMessages).toHaveLength(1);
  });
});

describe("automatic moderation recovery and preserved decisions", () => {
  it.each(["notification", "points"] as const)(
    "preserves the separate commit boundary when the %s write fails, including a retry",
    async (failure) => {
      submission({ id: "waiting", status: "pending_openai" });
      env.LOCAL_UPLOAD_AUTO_APPROVE = "true";
      const headers = createReviewerSession("a");
      // Fail a real database write, leaving the production workflow and transaction real.
      database.sqlite.exec(
        failure === "notification"
          ? `CREATE TEMP TRIGGER fail_review_write BEFORE INSERT ON notification_messages
           BEGIN SELECT RAISE(ABORT, 'notification write failed'); END`
          : `CREATE TEMP TRIGGER fail_review_write BEFORE UPDATE OF points ON users
           BEGIN SELECT RAISE(ABORT, 'points write failed'); END`,
      );
      const options = { method: "POST", headers, body: { ids: ["waiting"] } };
      const failed = await request("/run", options);
      expect(failed.status).toBe(500);
      expect(storedSnapshot("waiting")).toMatchObject({
        review_status: failure === "notification" ? "pending_openai" : "approved",
      });
      expect(authorPoints()).toBe(20);
      expect(reviewAudits()).toHaveLength(failure === "notification" ? 0 : 1);
      expect(notificationMessages()).toHaveLength(failure === "notification" ? 0 : 1);
      expect(liveMessages).toHaveLength(failure === "notification" ? 0 : 1);
      expect(translationMessages).toHaveLength(failure === "notification" ? 0 : 1);
      database.sqlite.exec("DROP TRIGGER fail_review_write");
      const retry = await request("/run", options);
      expect(retry.status).toBe(200);
      expect(storedSnapshot("waiting")).toMatchObject({ review_status: "approved" });
      // A committed review is not replayed to recover a failed independent points write.
      expect(authorPoints()).toBe(failure === "notification" ? 22 : 20);
      expect(reviewAudits()).toHaveLength(1);
      expect(notificationMessages()).toHaveLength(1);
      expect(liveMessages).toHaveLength(1);
      expect(translationMessages).toHaveLength(1);
    },
  );

  it.each([
    { history: "an earlier approved version", expectedPoints: 20 },
    { history: "a first version deferred to manual review", expectedPoints: 22 },
  ])(
    "rewards approval after $history with $expectedPoints points and prewarm disabled",
    async ({ history, expectedPoints }) => {
      env.OPENAI_API_KEY = "synthetic-ai-key";
      env.ENABLE_COMMENT_TRANSLATION_PREWARM = "false";
      submission({
        id: "edited",
        status: "pending_openai",
      });
      if (history === "an earlier approved version") {
        database.sqlite.exec(
          `UPDATE ugc_snapshots SET review_status='approved' WHERE submission_id='edited'`,
        );
        expect(
          await appendCommentVersion(database.db, {
            submissionId: "edited",
            parentSnapshotId: "snapshot-edited",
            snapshotId: "edited-B",
            actorId: "author",
            content: "Corrected directions",
          }),
        ).toMatchObject({ outcome: "appended" });
      }
      const headers = createReviewerSession("a");
      if (history === "an earlier approved version") {
        vi.mocked(fetch).mockResolvedValue(Response.json({ results: [{ flagged: false }] }));
        const response = await request("/run", {
          method: "POST",
          headers,
          body: { ids: ["edited"] },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ processed: 1, active: 1 });
      } else {
        env.SKIP_AI_MODERATION = "true";
        const deferred = await request("/run", {
          method: "POST",
          headers,
          body: { ids: ["edited"] },
        });
        expect(deferred.status).toBe(200);
        expect(await deferred.json()).toMatchObject({ pendingAudit: 1, active: 0 });
        expect(authorPoints()).toBe(20);
        const response = await request("/edited/status", {
          method: "PATCH",
          headers,
          body: {
            action: "approve",
            snapshotId: "snapshot-edited",
            expectedReviewStatus: "pending_audit",
          },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ outcome: "committed" });
        expect(fetch).not.toHaveBeenCalled();
      }
      expect(storedSnapshot("edited")).toMatchObject({
        review_status: "approved",
      });
      // Only the first approval earns points; editing approved content cannot earn them again.
      expect(authorPoints()).toBe(expectedPoints);
      expect(translationMessages).toEqual([]);
      expect(notificationMessages()).toHaveLength(
        history === "an earlier approved version" ? 1 : 2,
      );
    },
  );
});
