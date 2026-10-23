import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModerationTestFixture,
  type ModerationTestFixture,
} from "@/test/fixtures/moderation";
import { insertUser } from "@/test/fixtures/users";

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

describe("manual moderation recovery and preserved decisions", () => {
  it("reports malformed review JSON as a validation error without applying a decision", async () => {
    submission({ id: "waiting", status: "pending_audit" });
    const before = storedSubmission("waiting");
    const response = await request("/waiting/status", {
      method: "PATCH",
      headers: createReviewerSession(),
      rawBody: '{"status":',
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(storedSubmission("waiting")).toEqual(before);
    expect(authorPoints()).toBe(20);
    expect(reviewEvents()).toEqual([]);
    expect(notificationMessages()).toEqual([]);
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
