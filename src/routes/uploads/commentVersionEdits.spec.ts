import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type SessionHeaders } from "@/test/fixtures/auth";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";

const { cache, redis } = vi.hoisted(() => ({
  cache: { purgeMarker: vi.fn() },
  redis: { zremrangebyscore: vi.fn(), zcard: vi.fn(), zadd: vi.fn(), expire: vi.fn() },
}));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: cache },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {
      return redis;
    }
  },
}));

let database: TestDatabase;
let mocks: MockBindings;
let author: SessionHeaders;
let admin: SessionHeaders;
let reviewer: SessionHeaders;

beforeEach(() => {
  vi.resetAllMocks();
  for (const fn of Object.values(redis)) {
    fn.mockResolvedValue(0);
  }
  cache.purgeMarker.mockResolvedValue({ success: true });
  database = createTestDatabase();
  author = insertAuthenticatedUser(database.sqlite, { uid: "author" }).headers;
  admin = insertAuthenticatedUser(database.sqlite, { uid: "admin", role: "a" }).headers;
  reviewer = insertAuthenticatedUser(database.sqlite, { uid: "reviewer", role: "p" }).headers;

  insertCommentSnapshot(database.sqlite, {
    id: "comment",
    userId: "author",
    snapshotId: "A",
    content: "Published A",
  });
  mocks = createMockBindings({ DB: database.db });
  mocks.bindings.LOCK_UPLOAD_ENDPOINTS = "false";
  mocks.autoModerationQueue.send.mockResolvedValue({
    metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
  });
});
afterEach(() => database.close());

async function edit(body: object, headers = author) {
  const pending: Promise<unknown>[] = [];
  const response = await runWithAuthRequest(() =>
    createApp().request(
      "http://localhost/uploads/v1/comments/comment/edit",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      mocks.bindings,
      { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext,
    ),
  );
  await Promise.all(pending);
  return response;
}

it("appends normalized content, queues the committed version and preserves author and flags", async () => {
  database.sqlite.exec(
    "INSERT INTO ugc_submission_flags (submission_id,user_id,active) VALUES ('comment','reviewer',1)",
  );
  const response = await edit({ content: "  Private B  ", parentSnapshotId: "A" }, admin);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { submission: { snapshotId: string } };
  expect(payload).toMatchObject({ submission: { id: "comment", status: "pending_openai" } });
  expect(
    database.sqlite
      .prepare("SELECT user_id,revision FROM ugc_submissions WHERE id='comment'")
      .get(),
  ).toEqual({ user_id: "author", revision: 2 });
  expect(
    database.sqlite
      .prepare("SELECT content,creator_user_id,review_status FROM ugc_snapshots WHERE id=?")
      .get(payload.submission.snapshotId),
  ).toEqual({ content: "Private B", creator_user_id: "admin", review_status: "pending_openai" });
  expect(database.sqlite.prepare("SELECT active FROM ugc_submission_flags").get()).toEqual({
    active: 1,
  });
  expect(mocks.autoModerationQueue.send).toHaveBeenCalledExactlyOnceWith({
    type: "moderation",
    submissionId: "comment",
    snapshotId: payload.submission.snapshotId,
    source: "upload",
    queuedAt: expect.any(String),
  });
  expect(
    (await edit({ content: "Private B", parentSnapshotId: payload.submission.snapshotId })).status,
  ).toBe(409);
});

it("validates permission and baseline before accepting a same-content no-op", async () => {
  expect((await edit({ content: "Published A" })).status).toBe(422);
  expect((await edit({ content: "Published A", parentSnapshotId: "A" }, reviewer)).status).toBe(
    403,
  );
  expect((await edit({ content: "Published A", parentSnapshotId: "old" })).status).toBe(409);
  const response = await edit({ content: "  Published A  ", parentSnapshotId: "A" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    submission: { snapshotId: "A", status: "active" },
  });
  expect(database.sqlite.prepare("SELECT count(*) AS count FROM ugc_snapshots").get()).toEqual({
    count: 1,
  });
  expect(mocks.autoModerationQueue.send).not.toHaveBeenCalled();
  expect(cache.purgeMarker).not.toHaveBeenCalled();
});

it.each(["pending_openai", "pending_audit", "rejected", "unknown", "deleted", "disabled"])(
  "rejects editing %s even when the body is unchanged",
  async (state) => {
    if (state === "deleted") {
      database.sqlite.exec("UPDATE ugc_submissions SET author_deleted_at='gone'");
    } else if (state === "disabled") {
      database.sqlite.exec(
        "UPDATE ugc_submissions SET admin_deleted_at='gone',admin_deleted_by='admin'",
      );
    } else {
      database.sqlite.prepare("UPDATE ugc_snapshots SET review_status=?").run(state);
    }
    expect((await edit({ content: "Published A", parentSnapshotId: "A" })).status).toBe(409);
    expect(mocks.autoModerationQueue.send).not.toHaveBeenCalled();
  },
);

it("creates a fresh version when returning to historical text and retains the commit on queue failure", async () => {
  const first = await edit({ content: "Published B", parentSnapshotId: "A" });
  const { submission } = (await first.json()) as { submission: { snapshotId: string } };
  database.sqlite
    .prepare("UPDATE ugc_snapshots SET review_status='approved' WHERE id=?")
    .run(submission.snapshotId);
  mocks.autoModerationQueue.send.mockRejectedValueOnce(new Error("Queue unavailable"));
  expect(
    (await edit({ content: "Published A", parentSnapshotId: submission.snapshotId })).status,
  ).toBe(500);
  expect(database.sqlite.prepare("SELECT revision FROM ugc_submissions").get()).toEqual({
    revision: 3,
  });
  expect(
    database.sqlite
      .prepare(
        "SELECT content,review_status,moderation_queued_at FROM ugc_snapshots WHERE revision=3",
      )
      .get(),
  ).toEqual({
    content: "Published A",
    review_status: "pending_openai",
    moderation_queued_at: null,
  });
  expect(cache.purgeMarker).toHaveBeenCalledTimes(2);
});

it("does not edit a missing submission or an image", async () => {
  insertImageSnapshot(database.sqlite, { id: "image", userId: "author" });
  for (const id of ["missing", "image"]) {
    const response = await runWithAuthRequest(() =>
      createApp().request(
        `http://localhost/uploads/v1/comments/${id}/edit`,
        {
          method: "POST",
          headers: { ...author, "content-type": "application/json" },
          body: JSON.stringify({ content: "Changed", parentSnapshotId: "snapshot-image" }),
        },
        mocks.bindings,
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
  }
  expect(
    database.sqlite.prepare("SELECT revision FROM ugc_submissions WHERE id='image'").get(),
  ).toEqual({ revision: 1 });
  expect(mocks.autoModerationQueue.send).not.toHaveBeenCalled();
});
