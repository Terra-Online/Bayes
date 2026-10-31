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
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
  );
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
  mocks.bindings.LOCK_MODERATION_ENDPOINTS = "false";
  mocks.authRateLimit.limit.mockResolvedValue({ success: true });
  mocks.webhookQueue.send.mockResolvedValue({
    metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
  });
  mocks.autoModerationQueue.send.mockResolvedValue({
    metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
});

async function post(path: string, body: object = { snapshotId: "A" }, headers = reviewer) {
  const pending: Promise<unknown>[] = [];
  const response = await runWithAuthRequest(() =>
    createApp().request(
      `http://localhost/uploads/v1${path}`,
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

it("requires the clicked public version for flag and unflag, including no-ops", async () => {
  for (const action of ["flag", "unflag"]) {
    expect((await post(`/comments/comment/${action}`, {})).status).toBe(422);
    expect((await post(`/comments/comment/${action}`, { snapshotId: "old" })).status).toBe(409);
  }
  const first = await post("/comments/comment/flag");
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ created: true, status: "flagged", flagCount: 1 });
  expect(await (await post("/comments/comment/flag")).json()).toMatchObject({
    created: false,
    flagCount: 1,
  });
  expect(await (await post("/comments/comment/unflag")).json()).toMatchObject({
    deleted: true,
    status: "active",
    flagCount: 0,
  });
  expect(await (await post("/comments/comment/unflag")).json()).toMatchObject({
    deleted: false,
    flagCount: 0,
  });
});

it("sets and cancels image likes without a snapshot field and rejects hidden writes", async () => {
  insertImageSnapshot(database.sqlite, { id: "image", userId: "author" });
  expect(await (await post("/images/image/upvote", {})).json()).toMatchObject({
    created: true,
    upvoteCount: 1,
  });
  expect(await (await post("/images/image/upvote", {})).json()).toMatchObject({
    created: false,
    upvoteCount: 1,
  });
  expect(await (await post("/images/image/unvote", {})).json()).toMatchObject({
    deleted: true,
    upvoteCount: 0,
  });
  expect(await (await post("/images/image/unvote", {})).json()).toMatchObject({
    deleted: false,
    upvoteCount: 0,
  });
  expect((await post("/images/image/upvote", {})).status).toBe(200);
  database.sqlite.exec("UPDATE ugc_submissions SET author_deleted_at='gone' WHERE id='image'");
  for (const action of ["upvote", "unvote"]) {
    expect((await post(`/images/image/${action}`, {})).status).toBe(409);
  }
  expect(database.sqlite.prepare("SELECT active FROM ugc_submission_upvotes").get()).toEqual({
    active: 1,
  });
});

function addPendingVersion(id = "comment", kind = "comment") {
  database.sqlite
    .prepare(`INSERT INTO ugc_snapshots
    (id,submission_id,kind,revision,content,file_path,review_status,creator_user_id)
    VALUES ('B',?,?,2,'Version B',?,'pending_openai','author')`)
    .run(id, kind, kind === "image" ? "images/B.webp" : null);
  database.sqlite.prepare("UPDATE ugc_submissions SET revision=2 WHERE id=?").run(id);
}

async function review(id = "comment", decision: "approved" | "rejected" = "approved") {
  const response = await management(`/${id}/status`, {
    action: decision === "approved" ? "approve" : "reject",
    snapshotId: "B",
    expectedReviewStatus: "pending_openai",
  });
  return response;
}

it.each(["comment", "image"] as const)(
  "binds %s flags and withdrawals to public A while B is pending and rejects both stale directions",
  async (kind) => {
    const id = kind;
    const prefix = kind === "comment" ? "comments" : "images";
    if (kind === "image") {
      insertImageSnapshot(database.sqlite, { id, userId: "author", snapshotId: "A-image" });
    }
    const snapshotId = kind === "comment" ? "A" : "A-image";
    addPendingVersion(id, kind);
    const request = (action: string, version = snapshotId) =>
      post(`/${prefix}/${id}/${action}`, { snapshotId: version });
    expect(await (await request("flag")).json()).toMatchObject({ created: true, flagCount: 1 });
    expect(await (await request("unflag")).json()).toMatchObject({ deleted: true, flagCount: 0 });
    expect((await request("flag", "B")).status).toBe(409);
    expect((await request("flag")).status).toBe(200);
    const firstReview = await review(id);
    expect(firstReview.status).toBe(200);
    expect(
      database.sqlite
        .prepare("SELECT active FROM ugc_submission_flags WHERE submission_id=?")
        .get(id),
    ).toEqual({ active: 0 });
    for (const action of ["flag", "unflag"]) {
      expect((await request(action)).status).toBe(409);
    }
    expect((await request("flag", "B")).status).toBe(200);
    // A duplicate real review must not clear a fresh report on B.
    expect((await review(id)).status).toBe(409);
    expect(
      database.sqlite
        .prepare("SELECT active FROM ugc_submission_flags WHERE submission_id=?")
        .get(id),
    ).toEqual({ active: 1 });
  },
);

it.each(["author", "admin", "rejected"])(
  "retains reports when %s hides content and rejects both directions",
  async (reason) => {
    await post("/comments/comment/flag");
    if (reason === "rejected") {
      addPendingVersion();
      expect((await review("comment", "rejected")).status).toBe(200);
    } else {
      database.sqlite.exec(
        reason === "author"
          ? "UPDATE ugc_submissions SET author_deleted_at='gone'"
          : "UPDATE ugc_submissions SET admin_deleted_at='gone',admin_deleted_by='admin'",
      );
    }
    for (const action of ["flag", "unflag"]) {
      expect((await post(`/comments/comment/${action}`)).status).toBe(409);
    }
    expect(database.sqlite.prepare("SELECT active FROM ugc_submission_flags").get()).toEqual({
      active: 1,
    });
    expect(mocks.webhookQueue.send).toHaveBeenCalledTimes(1);
  },
);

it("preserves self-report policy, distinguishes missing/kind mismatch, and only notifies committed changes", async () => {
  for (const action of ["flag", "unflag"]) {
    expect((await post(`/comments/comment/${action}`, { snapshotId: "A" }, author)).status).toBe(
      403,
    );
    expect((await post(`/comments/missing/${action}`)).status).toBe(404);
    expect((await post(`/images/comment/${action}`)).status).toBe(404);
  }
  await post("/comments/comment/flag");
  await post("/comments/comment/flag");
  await post("/comments/comment/unflag");
  await post("/comments/comment/unflag");
  await post("/comments/comment/flag");
  expect(
    mocks.webhookQueue.send.mock.calls.map(([message]) =>
      message.type === "discord_notification" ? message.event.type : message.type,
    ),
  ).toEqual(["flag_created", "flag_removed", "flag_created"]);
  expect((await post("/comments/comment/flag", { snapshotId: "A" }, admin)).status).toBe(200);
  expect(await (await post("/comments/comment/unflag")).json()).toMatchObject({
    status: "flagged",
    flagCount: 1,
  });
  expect(
    await (await post("/comments/comment/unflag", { snapshotId: "A" }, admin)).json(),
  ).toMatchObject({ status: "active", flagCount: 0 });
});

it("preserves like timestamps on duplicate and cancel, aggregates reactivation, and never expires groups for ineligible writes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
    insertImageSnapshot(database.sqlite, { id: "image", userId: "author" });
    await post("/images/image/upvote", {});
    const original = database.sqlite.prepare("SELECT created_at FROM ugc_submission_upvotes").get();
    await post("/images/image/upvote", {});
    await post("/images/image/unvote", {});
    expect(database.sqlite.prepare("SELECT created_at FROM ugc_submission_upvotes").get()).toEqual(
      original,
    );
    // A second real set in the same millisecond is a new event, a duplicate set is not.
    await post("/images/image/upvote", {});
    expect(database.sqlite.prepare("SELECT message_count FROM notifications").get()).toEqual({
      message_count: 2,
    });
    database.sqlite.exec("UPDATE notifications SET read_at='read'");
    vi.setSystemTime(new Date("2026-10-29T07:00:00.000Z"));
    const before = database.sqlite.prepare("SELECT * FROM notifications").all();
    await post("/images/image/upvote", {});
    expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual(before);
    await post("/images/image/unvote", {});
    await post("/images/image/upvote", {});
    expect(
      database.sqlite
        .prepare("SELECT message_count,read_at FROM notifications ORDER BY created_at")
        .all(),
    ).toEqual([
      { message_count: 2, read_at: "read" },
      { message_count: 1, read_at: null },
    ]);
    expect(database.sqlite.prepare("SELECT created_at FROM ugc_submission_upvotes").get()).toEqual({
      created_at: "2026-10-29T07:00:00.000Z",
    });
    database.sqlite.exec(
      "UPDATE ugc_submissions SET admin_deleted_at='gone',admin_deleted_by='admin' WHERE id='image'",
    );
    const hiddenBefore = database.sqlite.prepare("SELECT * FROM notifications").all();
    expect((await post("/images/image/upvote", {})).status).toBe(409);
    expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual(hiddenBefore);
    expect((await post("/images/missing/upvote", {})).status).toBe(404);
    expect((await post("/images/comment/unvote", {})).status).toBe(404);
  } finally {
    vi.useRealTimers();
  }
});

it("rolls reports back on persistence failure without external notifications", async () => {
  database.sqlite.exec(`CREATE TRIGGER fail_report BEFORE INSERT ON ugc_submission_flags
    BEGIN SELECT RAISE(ABORT,'report unavailable'); END`);
  expect((await post("/comments/comment/flag")).status).toBe(500);
  expect(database.sqlite.prepare("SELECT * FROM ugc_submission_flags").all()).toEqual([]);
  expect(mocks.webhookQueue.send).not.toHaveBeenCalled();
  database.sqlite.exec("DROP TRIGGER fail_report");
  expect((await post("/comments/comment/flag")).status).toBe(200);
  expect(mocks.webhookQueue.send).toHaveBeenCalledTimes(1);
});

it("rolls image likes and notification aggregation back together when either write fails", async () => {
  insertImageSnapshot(database.sqlite, { id: "image", userId: "author" });
  for (const table of ["ugc_submission_upvotes", "notification_messages"]) {
    database.sqlite.exec(`CREATE TRIGGER fail_vote BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT,'vote unavailable'); END`);
    expect((await post("/images/image/upvote", {})).status).toBe(500);
    for (const name of [
      "ugc_submission_upvotes",
      "notifications",
      "notification_messages",
      "notification_counters",
    ]) {
      expect(database.sqlite.prepare(`SELECT * FROM ${name}`).all()).toEqual([]);
    }
    database.sqlite.exec("DROP TRIGGER fail_vote");
  }
  expect((await post("/images/image/upvote", {})).status).toBe(200);
  expect(database.sqlite.prepare("SELECT message_count FROM notifications").get()).toEqual({
    message_count: 1,
  });
});

async function management(path: string, body?: object) {
  const pending: Promise<unknown>[] = [];
  const response = await runWithAuthRequest(() =>
    createApp().request(
      `http://localhost/moderation/v1${path}`,
      {
        method: body ? "PATCH" : "GET",
        headers: { ...admin, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      mocks.bindings,
      { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext,
    ),
  );
  await Promise.all(pending);
  return response;
}

it.each(["comment", "image"] as const)(
  "integrates %s user reports with management's public/frontier targets and retained hidden report clearing",
  async (kind) => {
    mocks.bindings.LOCK_MODERATION_ENDPOINTS = "false";
    const id = kind;
    const prefix = kind === "comment" ? "comments" : "images";
    const snapshotId = kind === "comment" ? "A" : "A-image";
    if (kind === "image") {
      insertImageSnapshot(database.sqlite, { id, userId: "author", snapshotId });
    }
    database.sqlite
      .prepare("UPDATE ugc_submissions SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?")
      .run(id);
    addPendingVersion(id, kind);
    expect((await post(`/${prefix}/${id}/flag`, { snapshotId })).status).toBe(200);
    const browse = await management("/pending?mode=reports&limit=1");
    expect(browse.status).toBe(200);
    expect(await browse.json()).toMatchObject({
      items: [
        {
          id,
          frontier: { snapshotId: "B" },
          publicSnapshot: { snapshotId },
          reportSnapshotId: snapshotId,
          flagCount: 1,
        },
      ],
      nextOffset: null,
    });
    expect(
      (await management(`/${id}/status`, { action: "clear_flags", snapshotId: "B" })).status,
    ).toBe(409);
    // Real ticket07 review replaces A and clears only A reports.
    expect((await review(id)).status).toBe(200);
    expect((await post(`/${prefix}/${id}/flag`, { snapshotId: "B" })).status).toBe(200);
    expect((await management(`/${id}/status`, { action: "clear_flags", snapshotId })).status).toBe(
      409,
    );
    // Author deletion has no points/review side effect and retains the current report.
    database.sqlite
      .prepare("UPDATE ugc_submissions SET author_deleted_at='gone' WHERE id=?")
      .run(id);
    const hidden = await management(
      "/pending?mode=reports&limit=1&status=pending_openai&from=2026-01-01T00:00:00Z",
    );
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toMatchObject({
      items: [
        {
          id,
          publicSnapshot: null,
          reportSnapshotId: "B",
          flagCount: 1,
          authorDeletedAt: "gone",
        },
      ],
    });
    expect((await post(`/${prefix}/${id}/unflag`, { snapshotId: "B" })).status).toBe(409);
    const audits = database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all();
    const messages = database.sqlite.prepare("SELECT * FROM notification_messages").all();
    expect(
      await (await management(`/${id}/status`, { action: "clear_flags", snapshotId: "B" })).json(),
    ).toMatchObject({ ok: true, outcome: "committed" });
    expect(
      await (await management(`/${id}/status`, { action: "clear_flags", snapshotId: "B" })).json(),
    ).toMatchObject({ ok: true, outcome: "no_op" });
    expect(await (await management("/pending?mode=reports&limit=1")).json()).toMatchObject({
      items: [],
      stats: { total: 0 },
    });
    expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual(
      audits,
    );
    expect(database.sqlite.prepare("SELECT * FROM notification_messages").all()).toEqual(messages);
    expect(
      database.sqlite.prepare("SELECT author_deleted_at FROM ugc_submissions WHERE id=?").get(id),
    ).toEqual({ author_deleted_at: "gone" });
  },
);
