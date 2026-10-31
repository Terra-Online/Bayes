import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { appendCommentVersion } from "@/repositories/submission/appendCommentVersion";
import { createSnapshotModerationFixture } from "@/test/fixtures/management";
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

let fixture: ReturnType<typeof createSnapshotModerationFixture>;
beforeEach(() => {
  redisCounts.clear();
  fixture = createSnapshotModerationFixture();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("image")),
  );
});
afterEach(() => {
  fixture.database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function command(
  action: "approve" | "reject" | "send_to_manual",
  id: string,
  expectedReviewStatus = "pending_audit",
) {
  return { action, snapshotId: `snapshot-${id}`, expectedReviewStatus };
}
function patch(id: string, body: unknown, headers: Record<string, string>) {
  return fixture.request(`/${id}/status`, { method: "PATCH", body, headers });
}
function status(id: string) {
  return fixture.database.sqlite
    .prepare("SELECT review_status FROM ugc_snapshots WHERE id=?")
    .get(id)?.review_status;
}

it("requires a real session and keeps moderation locked by default", async () => {
  fixture.submission({ id: "waiting", reviewStatus: "pending_audit" });
  expect((await fixture.request("/pending")).status).toBe(401);
  expect(
    (
      await fixture.request("/waiting/status", {
        method: "PATCH",
        body: command("approve", "waiting"),
      })
    ).status,
  ).toBe(401);
  delete fixture.env.LOCK_MODERATION_ENDPOINTS;
  const headers = fixture.createReviewerSession("a");
  for (const [path, method, body] of [
    ["/pending", "GET", undefined],
    ["/waiting/status", "PATCH", command("approve", "waiting")],
    ["/run", "POST", { ids: ["waiting"] }],
  ] as const) {
    expect((await fixture.request(path, { method, body, headers })).status).toBe(503);
  }
  expect(status("snapshot-waiting")).toBe("pending_audit");
  expect(fixture.authorPoints()).toBe(20);
  expect(fixture.reviewAudits()).toEqual([]);
});
it.each([
  { role: "n", review: 403, run: 403 },
  { role: "s", review: 403, run: 403 },
  { role: "p", review: 200, run: 403 },
  { role: "a", review: 200, run: 200 },
  { role: "r", review: 200, run: 200 },
] as const)(
  "preserves $role management and automatic-run permissions",
  async ({ role, review, run }) => {
    fixture.submission({ id: "waiting", reviewStatus: "pending_audit" });
    const headers = fixture.createReviewerSession(role);
    expect((await fixture.request("/pending", { headers })).status).toBe(review);
    expect((await patch("waiting", command("approve", "waiting"), headers)).status).toBe(review);
    expect((await fixture.request("/run", { method: "POST", body: {}, headers })).status).toBe(run);
    expect(status("snapshot-waiting")).toBe(review === 200 ? "approved" : "pending_audit");
    expect(fixture.authorPoints()).toBe(review === 200 ? 22 : 20);
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
  expect(
    (
      await fixture.request(path, {
        method,
        headers: fixture.createReviewerSession("p"),
        body: method === "POST" ? {} : undefined,
      })
    ).status,
  ).toBe(403);
});
it.each([
  ["pending_openai", "approve", "approved", 22, "system.submission.approved"],
  ["pending_openai", "reject", "rejected", 14, null],
  ["pending_openai", "send_to_manual", "pending_audit", 20, "system.submission.needs_review"],
  ["pending_audit", "approve", "approved", 22, "system.submission.approved"],
  ["pending_audit", "reject", "rejected", 14, null],
] as const)(
  "commits %s %s with exact attribution and silent rejection",
  async (from, action, to, points, notificationType) => {
    fixture.submission({ id: "waiting", reviewStatus: from });
    const headers = fixture.createReviewerSession("p", "reviewer");
    expect(
      (await patch("waiting", { ...command(action, "waiting", from), note: "Checked" }, headers))
        .status,
    ).toBe(200);
    expect(status("snapshot-waiting")).toBe(to);
    expect(fixture.reviewAudits()).toEqual([
      {
        snapshot_id: "snapshot-waiting",
        from_status: from,
        to_status: to,
        source: "admin",
        admin_user_id: "reviewer",
        note: "Checked",
      },
    ]);
    expect(fixture.authorPoints()).toBe(points);
    expect(fixture.notificationMessages()).toEqual(
      notificationType
        ? [{ recipient_user_id: "author", type: notificationType, submission_id: "waiting" }]
        : [],
    );
    expect((await patch("waiting", command(action, "waiting", from), headers)).status).toBe(409);
    expect(fixture.reviewAudits()).toHaveLength(1);
    expect(fixture.authorPoints()).toBe(points);
    expect(fixture.messages.webhook).toHaveLength(to === "rejected" ? 0 : 1);
  },
);
it.each(["approved", "rejected", "unknown"] as const)(
  "refuses terminal %s review and generic restoration",
  async (reviewStatus) => {
    fixture.submission({ id: "waiting", reviewStatus });
    const headers = fixture.createReviewerSession();
    expect(
      (await patch("waiting", command("approve", "waiting", reviewStatus), headers)).status,
    ).toBe(409);
    expect(fixture.reviewAudits()).toEqual([]);
    expect(status("snapshot-waiting")).toBe(reviewStatus);
  },
);
it.each(["author_deleted_at", "admin_deleted_at"])("refuses review after %s", async (fact) => {
  fixture.submission({ id: "waiting", reviewStatus: "pending_audit" });
  fixture.database.sqlite.exec(`UPDATE ugc_submissions SET ${fact}='deleted'`);
  expect(
    (await patch("waiting", command("approve", "waiting"), fixture.createReviewerSession())).status,
  ).toBe(409);
  expect(fixture.reviewAudits()).toEqual([]);
  expect(fixture.notificationMessages()).toEqual([]);
  expect(fixture.authorPoints()).toBe(20);
});
it.each(["notification", "points"])(
  "retains the documented %s failure boundary and does not replay committed effects",
  async (failure) => {
    fixture.submission({ id: "waiting", reviewStatus: "pending_audit" });
    const headers = fixture.createReviewerSession();
    fixture.database.sqlite.exec(
      failure === "notification"
        ? "CREATE TEMP TRIGGER fail_write BEFORE INSERT ON notification_messages BEGIN SELECT RAISE(ABORT,'failed notification'); END"
        : "CREATE TEMP TRIGGER fail_write BEFORE UPDATE OF points ON users BEGIN SELECT RAISE(ABORT,'failed points'); END",
    );
    expect((await patch("waiting", command("approve", "waiting"), headers)).status).toBe(500);
    expect(status("snapshot-waiting")).toBe(
      failure === "notification" ? "pending_audit" : "approved",
    );
    expect(fixture.authorPoints()).toBe(20);
    expect(fixture.reviewAudits()).toHaveLength(failure === "notification" ? 0 : 1);
    expect(fixture.notificationMessages()).toHaveLength(failure === "notification" ? 0 : 1);
    expect(fixture.messages.live).toHaveLength(failure === "notification" ? 0 : 1);
    expect(fixture.messages.translation).toHaveLength(failure === "notification" ? 0 : 1);
    fixture.database.sqlite.exec("DROP TRIGGER fail_write");
    expect((await patch("waiting", command("approve", "waiting"), headers)).status).toBe(
      failure === "notification" ? 200 : 409,
    );
    expect(fixture.authorPoints()).toBe(failure === "notification" ? 22 : 20);
    expect(fixture.reviewAudits()).toHaveLength(1);
    expect(fixture.notificationMessages()).toHaveLength(1);
    expect(fixture.messages.live).toHaveLength(1);
    expect(fixture.messages.translation).toHaveLength(1);
  },
);
it.each([
  [false, 25],
  [true, 26],
] as const)("keeps surge=%s approval backoff without scoring retries", async (surge, expected) => {
  fixture.env.SURGE_MODE_ENABLED = String(surge);
  fixture.env.SURGE_BACKOFF_MULTIPLIER = "3";
  const headers = fixture.createReviewerSession();
  for (let i = 0; i < 5; i++) {
    const id = `c-${i}`;
    fixture.submission({ id, reviewStatus: "pending_audit" });
    expect((await patch(id, command("approve", id), headers)).status).toBe(200);
    expect((await patch(id, command("approve", id), headers)).status).toBe(409);
  }
  expect(fixture.authorPoints()).toBe(expected);
  expect(fixture.reviewAudits()).toHaveLength(5);
  expect(fixture.notificationMessages()).toHaveLength(5);
});
it("keeps image and comment reward counters separate and warms exact approved files", async () => {
  const headers = fixture.createReviewerSession();
  for (const [id, kind, points] of [
    ["c1", "comment", 22],
    ["c2", "comment", 23],
    ["i1", "image", 29],
    ["i2", "image", 34],
  ] as const) {
    fixture.submission({ id, kind, reviewStatus: "pending_audit" });
    expect((await patch(id, command("approve", id), headers)).status).toBe(200);
    expect(fixture.authorPoints()).toBe(points);
  }
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
    "https://assets.example.test/images/i1.webp",
    "https://assets.example.test/images/i2.webp",
  ]);
  expect(fixture.messages.translation).toEqual([
    expect.objectContaining({ submissionId: "c1" }),
    expect.objectContaining({ submissionId: "c2" }),
  ]);
});
it.each(["network", "http"])("retains approval if image warming fails via %s", async (failure) => {
  fixture.submission({ id: "image", kind: "image", reviewStatus: "pending_audit" });
  vi.mocked(fetch).mockImplementation(async () => {
    if (failure === "network") {
      throw new Error("unavailable");
    }
    return new Response(null, { status: 503 });
  });
  expect(
    (await patch("image", command("approve", "image"), fixture.createReviewerSession())).status,
  ).toBe(200);
  expect(status("snapshot-image")).toBe("approved");
  expect(fixture.authorPoints()).toBe(26);
  expect(fixture.notificationMessages()).toHaveLength(1);
});
it.each(["approve", "reject"] as const)(
  "reviews an approved comment's edit with %s without scoring it again",
  async (action) => {
    fixture.submission({ id: "edited" });
    expect(
      (
        await appendCommentVersion(fixture.env.DB, {
          submissionId: "edited",
          parentSnapshotId: "snapshot-edited",
          snapshotId: "B",
          actorId: "author",
          content: "Corrected directions",
        })
      ).outcome,
    ).toBe("appended");
    const headers = fixture.createReviewerSession();
    expect(
      (
        await patch(
          "edited",
          { action, snapshotId: "B", expectedReviewStatus: "pending_openai" },
          headers,
        )
      ).status,
    ).toBe(200);
    expect(fixture.authorPoints()).toBe(20);
    expect(status("B")).toBe(action === "approve" ? "approved" : "rejected");
    expect(fixture.reviewAudits()).toHaveLength(1);
    expect(fixture.messages.translation).toHaveLength(action === "approve" ? 1 : 0);
  },
);
it("approves a reply once and persists author/parent unread and live notifications", async () => {
  insertUser(fixture.database.sqlite, { uid: "parent-author", uid_number: 105 });
  fixture.submission({ id: "parent", userId: "parent-author" });
  fixture.submission({ id: "reply", parentId: "parent", depth: 1, reviewStatus: "pending_audit" });
  const headers = fixture.createReviewerSession();
  expect((await patch("reply", command("approve", "reply"), headers)).status).toBe(200);
  expect((await patch("reply", command("approve", "reply"), headers)).status).toBe(409);
  expect(fixture.authorPoints()).toBe(22);
  expect(fixture.notificationMessages()).toEqual([
    { recipient_user_id: "author", type: "system.submission.approved", submission_id: "reply" },
    { recipient_user_id: "parent-author", type: "community.comment.reply", submission_id: "reply" },
  ]);
  expect(fixture.messages.live).toEqual(
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
  expect(fixture.messages.live).toHaveLength(2);
  expect(fixture.messages.translation).toHaveLength(1);
  expect(fixture.messages.webhook).toHaveLength(1);
});
it("manual takeover requires the new displayed phase for the next review", async () => {
  fixture.submission({ id: "waiting", reviewStatus: "pending_openai" });
  const headers = fixture.createReviewerSession("p", "admin");
  expect(
    (await patch("waiting", command("send_to_manual", "waiting", "pending_openai"), headers))
      .status,
  ).toBe(200);
  expect(
    (await patch("waiting", command("approve", "waiting", "pending_openai"), headers)).status,
  ).toBe(409);
  expect(status("snapshot-waiting")).toBe("pending_audit");
  expect(fixture.reviewAudits()).toHaveLength(1);
  expect(fixture.reviewAudits()[0]).toMatchObject({ source: "admin", admin_user_id: "admin" });
  expect(fixture.authorPoints()).toBe(20);
});

it("rejects malformed JSON and missing submissions with their HTTP error contracts", async () => {
  fixture.submission({ id: "waiting", reviewStatus: "pending_audit" });
  const headers = fixture.createReviewerSession();
  const before = fixture.storedSubmission("waiting");
  const response = await fixture.request("/waiting/status", {
    method: "PATCH",
    headers,
    rawBody: '{"action":',
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  expect(fixture.storedSubmission("waiting")).toEqual(before);
  expect((await patch("missing", command("approve", "missing"), headers)).status).toBe(404);
  expect(fixture.reviewAudits()).toEqual([]);
});
it("disables an approved edit without charging its author again", async () => {
  fixture.submission({ id: "edited" });
  await appendCommentVersion(fixture.env.DB, {
    submissionId: "edited",
    parentSnapshotId: "snapshot-edited",
    snapshotId: "B",
    actorId: "author",
    content: "Correction",
  });
  const headers = fixture.createReviewerSession();
  expect((await patch("edited", { action: "disable", snapshotId: "B" }, headers)).status).toBe(200);
  expect(fixture.authorPoints()).toBe(20);
  expect(status("B")).toBe("pending_openai");
  expect(fixture.reviewAudits()).toEqual([]);
});
it.each(["rejected", "unknown"] as const)(
  "disables an already unavailable %s without an additional penalty",
  async (reviewStatus) => {
    fixture.submission({ id: "waiting", reviewStatus });
    expect(
      (
        await patch(
          "waiting",
          { action: "disable", snapshotId: "snapshot-waiting" },
          fixture.createReviewerSession(),
        )
      ).status,
    ).toBe(200);
    expect(fixture.authorPoints()).toBe(20);
    expect(status("snapshot-waiting")).toBe(reviewStatus);
    expect(fixture.reviewAudits()).toEqual([]);
  },
);
