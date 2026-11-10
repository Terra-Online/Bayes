import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createMockBindings, createMockR2Object } from "@/test/bindings";
import {
  createSnapshotModerationFixture,
  type SnapshotModerationFixture,
} from "@/test/fixtures/management";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: async () => ({ success: true }) } },
}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async get() {
      return null;
    }
    async set() {
      return "OK";
    }
    async eval() {
      return 1;
    }
  },
}));
vi.mock("@/lib/karma/karmaConfig.json", () => ({
  default: {
    levels: [
      { karma: 0, minPoints: 0 },
      { karma: 1, minPoints: 100 },
    ],
    scoreRules: {
      moderation: {
        approvedImage: 0,
        approvedComment: 0,
        rejectedSubmission: 0,
        approvedImageDailyBackoff: { halfRewardAtCount: 2, counterTtlSeconds: 3600 },
        approvedCommentDailyBackoff: { halfRewardAtCount: 2, counterTtlSeconds: 3600 },
      },
    },
    evaluation: {
      batchSize: 100,
      activity: { maxPassivePoints: 0, medianDays: 1 },
      decay: { inactiveAfterDays: 36500, penaltyAtMedianDays: 0, medianDays: 1 },
      quality: {
        imageApprovalBaseline: 0.5,
        imageApprovalWeight: 100,
        imageVolumeMedian: 1,
        minReviewedImages: 1,
      },
    },
  },
}));
let fixture: SnapshotModerationFixture;
beforeEach(() => {
  fixture = createSnapshotModerationFixture();
});
afterEach(() => {
  fixture.database.close();
  vi.restoreAllMocks();
});

it("returns a committed admin revision after queue delivery even when delivery bookkeeping fails", async () => {
  fixture.submission({ id: "comment", reviewStatus: "approved" });
  const headers = fixture.createReviewerSession("a", "admin");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fixture.database.sqlite.exec(`CREATE TEMP TRIGGER fail_queue_marker
    BEFORE UPDATE OF moderation_queued_at ON ugc_snapshots
    BEGIN SELECT RAISE(ABORT,'queue marker unavailable'); END`);

  const response = await fixture.request("/submissions/comment/revisions", {
    method: "POST",
    headers,
    body: { expectedSnapshotId: "snapshot-comment", content: "Corrected directions" },
  });

  expect(response.status).toBe(200);
  const payload = (await response.json()) as { submission: { snapshotId: string } };
  expect(fixture.storedSnapshot("comment")).toMatchObject({
    id: payload.submission.snapshotId,
    content: "Corrected directions",
    review_status: "pending_openai",
    moderation_queued_at: null,
  });
  expect(fixture.messages.moderation).toEqual([
    expect.objectContaining({
      submissionId: "comment",
      snapshotId: payload.submission.snapshotId,
      source: "upload",
    }),
  ]);
});

it("deletes and restores independently of review, audits each change, and rejects stale restoration", async () => {
  fixture.submission({ id: "comment", reviewStatus: "rejected" });
  const headers = fixture.createReviewerSession("a", "admin");
  const deleted = await fixture.request("/submissions/comment/delete", {
    method: "POST",
    headers,
    body: { expectedSnapshotId: "snapshot-comment", expectedLifecycleVersion: 0 },
  });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({
    outcome: "committed",
    deletedBy: "admin",
    lifecycleVersion: 1,
  });
  const restore = (version: number) =>
    fixture.request("/submissions/comment/restore", {
      method: "POST",
      headers,
      body: { expectedLifecycleVersion: version },
    });
  expect((await restore(0)).status).toBe(409);
  expect((await restore(1)).status).toBe(200);
  expect(fixture.storedSnapshot("comment")).toMatchObject({ review_status: "rejected" });
  expect(fixture.storedSubmission("comment")).toMatchObject({
    deleted_at: null,
    deleted_by: null,
    lifecycle_version: 2,
  });
  expect(
    fixture.database.sqlite
      .prepare("SELECT action,actor_user_id FROM ugc_submission_audit ORDER BY rowid")
      .all(),
  ).toEqual([
    { action: "deleted", actor_user_id: "admin" },
    { action: "restored", actor_user_id: "admin" },
  ]);
  expect(fixture.authorPoints()).toBe(20);
  expect(fixture.notificationMessages()).toEqual([]);
});

it("audits each cleared report under one operation, with no phantom events on repeat", async () => {
  fixture.submission({ id: "comment", reviewStatus: "rejected" });
  const headers = fixture.createReviewerSession("a", "admin");
  fixture.createReviewerSession("n", "reporter");
  fixture.database.sqlite.exec(
    "INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('comment','admin'),('comment','reporter')",
  );
  const clear = () =>
    fixture.request("/comment/status", {
      method: "PATCH",
      headers,
      body: { action: "clear_flags" },
    });
  expect((await clear()).status).toBe(200);
  expect((await clear()).status).toBe(200);
  const rows = fixture.database.sqlite
    .prepare(
      "SELECT action,reporter_user_id,actor_user_id,operation_id FROM ugc_submission_flag_audit ORDER BY reporter_user_id",
    )
    .all();
  expect(rows).toEqual([
    {
      action: "cleared",
      reporter_user_id: "admin",
      actor_user_id: "admin",
      operation_id: expect.any(String),
    },
    {
      action: "cleared",
      reporter_user_id: "reporter",
      actor_user_id: "admin",
      operation_id: expect.any(String),
    },
  ]);
  expect(rows[0].operation_id).toBe(rows[1].operation_id);
  expect(
    fixture.database.sqlite.prepare("SELECT SUM(active) AS count FROM ugc_submission_flags").get(),
  ).toEqual({ count: 0 });
  expect(() => fixture.database.sqlite.exec("DELETE FROM ugc_submission_flag_audit")).toThrow(
    /immutable/,
  );
});

it("corrects a historical review without reordering versions or replaying rewards, and prevents stale overrides", async () => {
  fixture.submission({ id: "comment", reviewStatus: "approved" });
  const headers = fixture.createReviewerSession("a", "admin");
  fixture.database.sqlite
    .exec(`INSERT INTO ugc_snapshots(id,submission_id,kind,revision,content,review_status,creator_user_id)
    VALUES ('B','comment','comment',2,'Rejected edit','rejected','author');
    UPDATE ugc_submissions SET revision=2,deleted_at='2026-01-01',deleted_by='author' WHERE id='comment'`);
  const act = (decision: string, version = 0) =>
    fixture.request("/submissions/comment/snapshots/snapshot-comment/review", {
      method: "PATCH",
      headers,
      body: { decision, expectedReviewStatus: "approved", expectedReviewVersion: version },
    });
  expect((await act("pending_audit")).status).toBe(422);
  expect((await act("rejected")).status).toBe(200);
  expect((await act("approved")).status).toBe(409);
  expect(fixture.storedSubmission("comment")).toMatchObject({ revision: 2, deleted_by: "author" });
  expect(fixture.storedSnapshot("comment")).toMatchObject({ id: "B", review_status: "rejected" });
  expect(fixture.authorPoints()).toBe(20);
  expect(fixture.notificationMessages()).toEqual([]);
  expect(fixture.reviewAudits()).toEqual([
    expect.objectContaining({
      snapshot_id: "snapshot-comment",
      from_status: "approved",
      to_status: "rejected",
      admin_user_id: "admin",
    }),
  ]);
  const reviewer = fixture.createReviewerSession("p", "reviewer");
  expect(
    (
      await fixture.request("/submissions/comment/snapshots/B/review", {
        method: "PATCH",
        headers: reviewer,
        body: { decision: "approved", expectedReviewStatus: "rejected", expectedReviewVersion: 0 },
      })
    ).status,
  ).toBe(403);
});

it("appends an admin correction while deleted, conflicts during pending review, and reuses historical content", async () => {
  fixture.submission({ id: "comment", reviewStatus: "rejected" });
  const headers = fixture.createReviewerSession("a", "admin");
  fixture.database.sqlite.exec(
    "UPDATE ugc_submissions SET deleted_at='2026-01-01',deleted_by='author'",
  );
  const append = (body: unknown) =>
    fixture.request("/submissions/comment/revisions", { method: "POST", headers, body });
  const response = await append({
    expectedSnapshotId: "snapshot-comment",
    content: "Corrected directions",
  });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { submission: { snapshotId: string } };
  expect(fixture.storedSnapshot("comment")).toMatchObject({
    content: "Corrected directions",
    review_status: "pending_openai",
    creator_user_id: "admin",
    creation_source: "admin",
    baseline_snapshot_id: "snapshot-comment",
  });
  expect(fixture.storedSubmission("comment")).toMatchObject({ revision: 2, deleted_by: "author" });
  expect(fixture.messages.moderation).toEqual([]);
  expect(
    (
      await append({
        expectedSnapshotId: payload.submission.snapshotId,
        content: "Another correction",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await fixture.request(
        `/submissions/comment/snapshots/${payload.submission.snapshotId}/review`,
        {
          method: "PATCH",
          headers,
          body: {
            decision: "rejected",
            expectedReviewStatus: "pending_openai",
            expectedReviewVersion: 0,
          },
        },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await append({
        expectedSnapshotId: payload.submission.snapshotId,
        sourceSnapshotId: "snapshot-comment",
      })
    ).status,
  ).toBe(200);
  expect(fixture.storedSnapshot("comment")).toMatchObject({
    revision: 3,
    content: "Content comment",
    source_snapshot_id: "snapshot-comment",
  });
  expect(fixture.authorPoints()).toBe(20);
});

it("exposes bounded object histories and historical snapshots only to administrators", async () => {
  fixture.submission({ id: "comment", reviewStatus: "unknown" });
  const headers = fixture.createReviewerSession("a", "admin");
  await fixture.request("/submissions/comment/snapshots/snapshot-comment/review", {
    method: "PATCH",
    headers,
    body: { decision: "approved", expectedReviewStatus: "unknown", expectedReviewVersion: 0 },
  });
  const page = await fixture.request("/submissions/comment/history?limit=1", { headers });
  expect(page.status).toBe(200);
  const history = (await page.json()) as {
    items: Array<{ object: string; action: string }>;
    nextCursor: string;
  };
  expect(history.items).toEqual([
    expect.objectContaining({ object: "snapshot", action: "reviewed" }),
  ]);
  expect(history.nextCursor).toEqual(expect.any(String));
  const next = await fixture.request(
    `/submissions/comment/history?limit=1&cursor=${encodeURIComponent(history.nextCursor)}`,
    { headers },
  );
  expect(((await next.json()) as { items: unknown[] }).items).toHaveLength(1);
  const snapshots = await fixture.request("/submissions/comment/snapshots?limit=1", { headers });
  expect(await snapshots.json()).toMatchObject({
    items: [{ snapshotId: "snapshot-comment", reviewVersion: 1, reviewStatus: "approved" }],
  });
  const detail = await fixture.request("/submissions/comment", { headers });
  expect(await detail.json()).toMatchObject({
    item: { id: "comment", deletedAt: null, deletedBy: null, lifecycleVersion: 0 },
  });
  const reviewer = fixture.createReviewerSession("p", "reviewer");
  expect(
    (await fixture.request("/submissions/comment/history", { headers: reviewer })).status,
  ).toBe(403);
  expect((await fixture.request("/submissions/missing/history", { headers })).status).toBe(404);
});

it("preserves image bytes when correcting a caption and authorizes historical files before storage access", async () => {
  fixture.submission({
    id: "image",
    kind: "image",
    reviewStatus: "approved",
    filePath: "images/original.webp",
  });
  const headers = fixture.createReviewerSession("a", "admin");
  const mocks = createMockBindings({ DB: fixture.env.DB });
  fixture.env.UGC_BUCKET = mocks.bindings.UGC_BUCKET;
  const response = await fixture.request("/submissions/image/revisions", {
    method: "POST",
    headers,
    body: { expectedSnapshotId: "snapshot-image", content: "A corrected caption" },
  });
  expect(response.status).toBe(200);
  expect(fixture.storedSnapshot("image")).toMatchObject({
    revision: 2,
    file_path: "images/original.webp",
    content: "A corrected caption",
    creation_source: "admin",
  });
  expect(fixture.messages.moderation).toEqual([
    expect.objectContaining({
      submissionId: "image",
      snapshotId: fixture.storedSnapshot("image")!.id,
    }),
  ]);
  const path = "/submissions/image/snapshots/snapshot-image/file";
  expect((await fixture.request(path)).status).toBe(401);
  const reviewer = fixture.createReviewerSession("p", "reviewer");
  expect((await fixture.request(path, { headers: reviewer })).status).toBe(403);
  expect(
    (await fixture.request("/submissions/image/snapshots/wrong/file", { headers })).status,
  ).toBe(404);
  expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
  const imageResponse = new Response("img");
  mocks.ugcBucket.get.mockResolvedValue({
    ...createMockR2Object({
      key: "images/original.webp",
      size: 3,
      httpMetadata: { contentType: "image/webp" },
    }),
    body: imageResponse.body!,
    bodyUsed: false,
    arrayBuffer: () => imageResponse.arrayBuffer(),
    bytes: () => imageResponse.bytes(),
    text: () => imageResponse.text(),
    json: () => imageResponse.json(),
    blob: () => imageResponse.blob(),
  });
  const file = await fixture.request(path, { headers });
  expect(file.status).toBe(200);
  expect(file.headers.get("cache-control")).toBe("private, no-store");
  expect(await file.text()).toBe("img");
});

it("detects review status changes away and back and rolls state back when lifecycle audit fails", async () => {
  fixture.submission({ id: "comment", reviewStatus: "approved" });
  const headers = fixture.createReviewerSession("a", "admin");
  const review = (
    decision: "approved" | "rejected",
    status: "approved" | "rejected",
    version: number,
  ) =>
    fixture.request("/submissions/comment/snapshots/snapshot-comment/review", {
      method: "PATCH",
      headers,
      body: { decision, expectedReviewStatus: status, expectedReviewVersion: version },
    });
  expect((await review("rejected", "approved", 0)).status).toBe(200);
  expect((await review("approved", "rejected", 1)).status).toBe(200);
  expect((await review("rejected", "approved", 0)).status).toBe(409);
  fixture.database.sqlite.exec(
    "CREATE TEMP TRIGGER fail_lifecycle BEFORE INSERT ON ugc_submission_audit BEGIN SELECT RAISE(ABORT,'audit failed'); END",
  );
  expect(
    (
      await fixture.request("/submissions/comment/delete", {
        method: "POST",
        headers,
        body: { expectedSnapshotId: "snapshot-comment", expectedLifecycleVersion: 0 },
      })
    ).status,
  ).toBe(500);
  expect(fixture.storedSubmission("comment")).toMatchObject({
    deleted_at: null,
    lifecycle_version: 0,
  });
  expect(fixture.database.sqlite.prepare("SELECT * FROM ugc_submission_audit").all()).toEqual([]);
});

it("keeps scheduled karma evaluation unchanged after an administrative review correction", async () => {
  fixture.submission({ id: "image", kind: "image", reviewStatus: "approved" });
  fixture.database.sqlite.exec("UPDATE users SET points=100,karma=1 WHERE uid='author'");
  const headers = fixture.createReviewerSession("a", "admin");
  const evaluate = () => fixture.request("/karma/run-once", { method: "POST", headers });
  expect((await evaluate()).status).toBe(200);
  expect(
    fixture.database.sqlite.prepare("SELECT karma FROM users WHERE uid='author'").get(),
  ).toEqual({ karma: 1 });
  expect(
    (
      await fixture.request("/submissions/image/snapshots/snapshot-image/review", {
        method: "PATCH",
        headers,
        body: { decision: "rejected", expectedReviewStatus: "approved", expectedReviewVersion: 0 },
      })
    ).status,
  ).toBe(200);
  expect((await evaluate()).status).toBe(200);
  expect(
    fixture.database.sqlite.prepare("SELECT karma,points FROM users WHERE uid='author'").get(),
  ).toEqual({ karma: 1, points: 100 });
  expect(
    (
      await fixture.request("/submissions/image/delete", {
        method: "POST",
        headers,
        body: { expectedSnapshotId: "snapshot-image", expectedLifecycleVersion: 0 },
      })
    ).status,
  ).toBe(200);
  expect((await evaluate()).status).toBe(200);
  expect(
    (
      await fixture.request("/submissions/image/restore", {
        method: "POST",
        headers,
        body: { expectedLifecycleVersion: 1 },
      })
    ).status,
  ).toBe(200);
  const edited = await fixture.request("/submissions/image/revisions", {
    method: "POST",
    headers,
    body: { expectedSnapshotId: "snapshot-image", content: "A corrected caption" },
  });
  const revision = (await edited.json()) as { submission: { snapshotId: string } };
  expect(edited.status).toBe(200);
  expect(
    (
      await fixture.request("/image/status", {
        method: "PATCH",
        headers,
        body: {
          action: "reject",
          snapshotId: revision.submission.snapshotId,
          expectedReviewStatus: "pending_openai",
        },
      })
    ).status,
  ).toBe(200);
  expect((await evaluate()).status).toBe(200);
  expect(
    fixture.database.sqlite.prepare("SELECT karma,points FROM users WHERE uid='author'").get(),
  ).toEqual({ karma: 1, points: 100 });
});

it("prevents a delayed legacy disable from undoing restoration and accepts the refreshed lifecycle token", async () => {
  fixture.submission({ id: "comment", reviewStatus: "approved" });
  const headers = fixture.createReviewerSession("a", "admin");
  const disable = (version?: number) =>
    fixture.request("/comment/status", {
      method: "PATCH",
      headers,
      body: {
        action: "disable",
        snapshotId: "snapshot-comment",
        ...(version === undefined ? {} : { expectedLifecycleVersion: version }),
      },
    });
  expect((await disable()).status).toBe(200);
  expect(
    (
      await fixture.request("/submissions/comment/restore", {
        method: "POST",
        headers,
        body: { expectedLifecycleVersion: 1 },
      })
    ).status,
  ).toBe(200);
  expect((await disable()).status).toBe(409);
  expect((await disable(2)).status).toBe(200);
});
