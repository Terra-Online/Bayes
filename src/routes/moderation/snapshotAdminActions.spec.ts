import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { createModerationTestFixture } from "@/test/fixtures/moderation";

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

import { appendCommentVersion } from "@/repositories/submission/appendCommentVersion";
import type { SnapshotReviewStatus } from "@/repositories/submission/snapshotReads";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";

let fixture: ReturnType<typeof createModerationTestFixture>;
beforeEach(() => {
  redisCounts.clear();
  fixture = createModerationTestFixture();
  importCurrentSubmissions(fixture.database);
  fixture.env.OPENAI_API_KEY = "test-key";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ results: [{ flagged: false }] })),
  );
});
afterEach(() => {
  fixture.database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function seed(id = "comment", reviewStatus: SnapshotReviewStatus = "pending_openai") {
  insertCommentSnapshot(fixture.database.sqlite, { id, userId: "author", reviewStatus });
}
async function act(
  body: unknown,
  id = "comment",
  headers = fixture.createReviewerSession("p", "admin"),
) {
  return fixture.request(`/${id}/status`, { method: "PATCH", headers, body });
}
it("approves the displayed frontier with the authenticated admin and rejects the old status contract", async () => {
  seed();
  const headers = fixture.createReviewerSession("p", "admin");
  expect((await act({ status: "active" }, "comment", headers)).status).toBe(422);
  const response = await act(
    {
      action: "approve",
      snapshotId: "snapshot-comment",
      expectedReviewStatus: "pending_openai",
      note: "Reviewed",
      adminUserId: "author",
    },
    "comment",
    headers,
  );
  expect(response.status).toBe(200);
  expect(
    fixture.database.sqlite
      .prepare(
        "SELECT snapshot_id,from_status,to_status,source,admin_user_id,note FROM ugc_snapshots_review_audit",
      )
      .all(),
  ).toEqual([
    {
      snapshot_id: "snapshot-comment",
      from_status: "pending_openai",
      to_status: "approved",
      source: "admin",
      admin_user_id: "admin",
      note: "Reviewed",
    },
  ]);
  expect(fixture.authorPoints()).toBe(22);
  expect(fixture.notificationMessages()).toHaveLength(1);
});

it("disables only the displayed frontier once, retains reports and review facts, and keeps points failure independent", async () => {
  seed("comment", "approved");
  const headers = fixture.createReviewerSession("a", "admin");
  fixture.database.sqlite.exec(
    "INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('comment','admin')",
  );
  expect((await act({ action: "disable", snapshotId: "old" }, "comment", headers)).status).toBe(
    409,
  );
  fixture.database.sqlite.exec(
    "CREATE TEMP TRIGGER fail_points BEFORE UPDATE OF points ON users BEGIN SELECT RAISE(ABORT,'points fail'); END",
  );
  const body = { action: "disable", snapshotId: "snapshot-comment" };
  expect((await act(body, "comment", headers)).status).toBe(500);
  expect(fixture.storedSubmission("comment")).toMatchObject({
    admin_deleted_by: "admin",
    author_deleted_at: null,
  });
  fixture.database.sqlite.exec("DROP TRIGGER fail_points");
  expect(await (await act(body, "comment", headers)).json()).toMatchObject({ outcome: "no_op" });
  expect(fixture.authorPoints()).toBe(20);
  expect(fixture.database.sqlite.prepare("SELECT active FROM ugc_submission_flags").get()).toEqual({
    active: 1,
  });
  expect(fixture.database.sqlite.prepare("SELECT review_status FROM ugc_snapshots").get()).toEqual({
    review_status: "approved",
  });
  expect(fixture.database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual(
    [],
  );
  expect(fixture.notificationMessages()).toEqual([]);
});
it("clears hidden retained reports explicitly without restoring or reviewing", async () => {
  seed("comment", "rejected");
  seed("other", "approved");
  const headers = fixture.createReviewerSession("p", "admin");
  fixture.database.sqlite.exec(
    "UPDATE ugc_submissions SET author_deleted_at='deleted' WHERE id='comment'; INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('comment','admin'),('other','admin')",
  );
  expect(
    (await act({ action: "clear_flags", snapshotId: "wrong" }, "comment", headers)).status,
  ).toBe(409);
  expect(
    await (
      await act({ action: "clear_flags", snapshotId: "snapshot-comment" }, "comment", headers)
    ).json(),
  ).toMatchObject({ outcome: "committed" });
  expect(
    await (
      await act({ action: "clear_flags", snapshotId: "snapshot-comment" }, "comment", headers)
    ).json(),
  ).toMatchObject({ outcome: "no_op" });
  expect(
    fixture.database.sqlite
      .prepare("SELECT * FROM ugc_public_submissions WHERE id='comment'")
      .all(),
  ).toEqual([]);
  expect(fixture.database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual(
    [],
  );
  expect(
    fixture.database.sqlite
      .prepare("SELECT active FROM ugc_submission_flags WHERE submission_id='other'")
      .get(),
  ).toEqual({ active: 1 });
  expect(fixture.authorPoints()).toBe(20);
  expect(fixture.notificationMessages()).toEqual([]);
});

it("browses retained hidden reports across bounded pages and ignores queue/date filters for deep links", async () => {
  seed("old", "rejected");
  seed("other", "approved");
  const headers = fixture.createReviewerSession("p", "admin");
  fixture.database.sqlite.exec(
    "UPDATE ugc_submissions SET author_deleted_at='deleted' WHERE id='old'; INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('old','admin'),('other','admin')",
  );
  const page = await fixture.request("/pending?mode=reports&limit=1", { headers });
  expect(page.status).toBe(200);
  expect(await page.json()).toMatchObject({
    items: [
      {
        id: "old",
        snapshotId: "snapshot-old",
        reviewStatus: "rejected",
        publicSnapshotId: null,
        publicSnapshot: null,
        reportSnapshotId: "snapshot-old",
        flagCount: 1,
        authorDeletedAt: "deleted",
        adminDeletedAt: null,
      },
    ],
    stats: { total: 2 },
    nextOffset: 1,
    offset: 0,
  });
  expect(
    await (await fixture.request("/pending?mode=reports&limit=1&offset=1", { headers })).json(),
  ).toMatchObject({ items: [{ id: "other" }], nextOffset: null });
  expect(
    await (
      await fixture.request(
        "/pending?submissionId=old&from=2099-01-01T00:00:00Z&status=active&offset=99&limit=1",
        { headers },
      )
    ).json(),
  ).toMatchObject({ items: [{ id: "old" }], stats: { total: 1 }, offset: 0, nextOffset: null });
});

it.each(["comment", "image"] as const)(
  "lists an old hidden reported %s without an ID or dates",
  async (kind) => {
    if (kind === "image") {
      insertImageSnapshot(fixture.database.sqlite, {
        id: "hidden",
        userId: "author",
        reviewStatus: "unknown",
        createdAt: "2020-01-01T00:00:00Z",
      });
    } else {
      insertCommentSnapshot(fixture.database.sqlite, {
        id: "hidden",
        userId: "author",
        reviewStatus: "rejected",
        createdAt: "2020-01-01T00:00:00Z",
      });
    }
    const headers = fixture.createReviewerSession("p", "admin");
    fixture.database.sqlite.exec(
      "UPDATE ugc_submissions SET admin_deleted_at='disabled',admin_deleted_by='admin'; INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('hidden','admin')",
    );
    const response = await fixture.request(
      "/pending?mode=reports&from=2099-01-01T00:00:00Z&status=pending_audit&limit=1",
      { headers },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        {
          id: "hidden",
          kind,
          reportSnapshotId: "snapshot-hidden",
          publicSnapshotId: null,
          flagCount: 1,
          adminDeletedAt: "disabled",
          adminDeletedBy: "admin",
        },
      ],
      stats: { total: 1 },
      nextOffset: null,
    });
  },
);
it("keeps public A and frontier B distinct and protects new B reports from an old A clear", async () => {
  seed("comment", "approved");
  expect(
    (
      await appendCommentVersion(fixture.env.DB, {
        submissionId: "comment",
        parentSnapshotId: "snapshot-comment",
        snapshotId: "B",
        actorId: "author",
        content: "Corrected directions",
      })
    ).outcome,
  ).toBe("appended");
  const headers = fixture.createReviewerSession("p", "admin");
  fixture.database.sqlite.exec(
    "INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('comment','admin')",
  );
  const before = await fixture.request("/pending?submissionId=comment", { headers });
  expect(await before.json()).toMatchObject({
    items: [
      {
        snapshotId: "B",
        reviewStatus: "pending_openai",
        content: "Corrected directions",
        frontier: { snapshotId: "B", content: "Corrected directions" },
        publicSnapshotId: "snapshot-comment",
        publicSnapshot: { snapshotId: "snapshot-comment", content: "Content comment" },
        reportSnapshotId: "snapshot-comment",
        latestReviewAudit: null,
        flagCount: 1,
      },
    ],
  });
  expect((await act({ action: "clear_flags", snapshotId: "B" }, "comment", headers)).status).toBe(
    409,
  );
  expect(
    (await act({ action: "disable", snapshotId: "snapshot-comment" }, "comment", headers)).status,
  ).toBe(409);
  expect(
    (
      await act(
        { action: "approve", snapshotId: "snapshot-comment", expectedReviewStatus: "approved" },
        "comment",
        headers,
      )
    ).status,
  ).toBe(409);
  expect(
    (await act({ action: "clear_flags", snapshotId: "snapshot-comment" }, "comment", headers))
      .status,
  ).toBe(200);
  expect(
    fixture.database.sqlite.prepare("SELECT snapshot_id FROM ugc_public_submissions").get(),
  ).toEqual({ snapshot_id: "snapshot-comment" });
  expect(
    (
      await act(
        { action: "approve", snapshotId: "B", expectedReviewStatus: "pending_openai" },
        "comment",
        headers,
      )
    ).status,
  ).toBe(200);
  fixture.database.sqlite.exec("UPDATE ugc_submission_flags SET active=1");
  expect(
    (await act({ action: "clear_flags", snapshotId: "snapshot-comment" }, "comment", headers))
      .status,
  ).toBe(409);
  expect(fixture.database.sqlite.prepare("SELECT active FROM ugc_submission_flags").get()).toEqual({
    active: 1,
  });
  const after = await fixture.request("/pending?submissionId=comment", { headers });
  expect(await after.json()).toMatchObject({
    items: [
      {
        snapshotId: "B",
        publicSnapshotId: "B",
        reportSnapshotId: "B",
        flagCount: 1,
        latestReviewAudit: {
          snapshotId: "B",
          fromStatus: "pending_openai",
          toStatus: "approved",
          source: "admin",
          adminUserId: "admin",
        },
      },
    ],
  });
  expect(fixture.authorPoints()).toBe(20);
});
it.each(["p", "a", "r"] as const)(
  "allows %s to disable once with the existing penalty and immutable first facts",
  async (role) => {
    seed("comment", "approved");
    const headers = fixture.createReviewerSession(role, "admin");
    const body = { action: "disable", snapshotId: "snapshot-comment" };
    const results = await Promise.all([
      act(body, "comment", headers),
      act(body, "comment", headers),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(
      (await Promise.all(results.map((result) => result.json())))
        .map((result) => (result as { outcome: string }).outcome)
        .sort(),
    ).toEqual(["committed", "no_op"]);
    const facts = fixture.storedSubmission("comment");
    const other = fixture.createReviewerSession("a", "other-admin");
    expect(await (await act(body, "comment", other)).json()).toMatchObject({ outcome: "no_op" });
    expect(fixture.storedSubmission("comment")).toEqual(facts);
    expect(fixture.authorPoints()).toBe(14);
    expect(fixture.notificationMessages()).toEqual([]);
  },
);
it.each(["n", "s"] as const)("denies %s report clearing and disable", async (role) => {
  seed("comment", "approved");
  const headers = fixture.createReviewerSession(role);
  for (const action of ["disable", "clear_flags"]) {
    expect((await act({ action, snapshotId: "snapshot-comment" }, "comment", headers)).status).toBe(
      403,
    );
  }
  expect(fixture.storedSubmission("comment")).toMatchObject({ admin_deleted_at: null });
});
it("requires action versions and displayed review phases at the HTTP seam", async () => {
  seed();
  const headers = fixture.createReviewerSession();
  for (const body of [
    { status: "active" },
    { action: "approve" },
    { action: "approve", snapshotId: "snapshot-comment" },
    { action: "disable" },
    { action: "clear_flags" },
  ]) {
    expect((await act(body, "comment", headers)).status).toBe(422);
  }
});
