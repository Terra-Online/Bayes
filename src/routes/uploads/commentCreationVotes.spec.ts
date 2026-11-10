import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createApp } from "@/app";
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
let bindings: MockBindings;
let headers: SessionHeaders;
let readerHeaders: SessionHeaders;
let pending: Promise<unknown>[];
const comment = {
  markerId: "marker-1",
  poiHash: "hash",
  poiType: "poi",
  content: "  Hello world  ",
};

beforeEach(() => {
  vi.resetAllMocks();
  database = createTestDatabase();
  headers = insertAuthenticatedUser(database.sqlite, { uid: "author" }).headers;
  readerHeaders = insertAuthenticatedUser(database.sqlite, { uid: "reader" }).headers;

  bindings = createMockBindings({ DB: database.db });
  bindings.bindings.LOCK_UPLOAD_ENDPOINTS = "false";
  bindings.autoModerationQueue.send.mockResolvedValue({
    metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
  });
  bindings.authRateLimit.limit.mockResolvedValue({ success: true });
  redis.zremrangebyscore.mockResolvedValue(0);
  redis.zcard.mockResolvedValue(0);
  redis.zadd.mockResolvedValue(1);
  redis.expire.mockResolvedValue(1);
  cache.purgeMarker.mockResolvedValue({ success: true });
  pending = [];
});
afterEach(async () => {
  await Promise.all(pending);
  vi.useRealTimers();
  database.close();
});

async function post(path: string, body?: unknown) {
  return createApp().request(
    `http://localhost/uploads/v1${path}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings.bindings,
    { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext,
  );
}

it("creates a normalized pending root and delivers exactly its stored snapshot", async () => {
  const response = await post("/comments", { ...comment, poiHash: " hash ", poiType: " poi " });
  expect(response.status).toBe(200);
  const { submission } = (await response.json()) as {
    submission: { id: string; snapshotId: string };
  };
  expect(submission).toMatchObject({ parentId: null, depth: 0, status: "pending_openai" });
  expect(
    database.sqlite
      .prepare(`SELECT s.user_id,s.revision,r.id,r.content,r.review_status,r.moderation_queued_at
    FROM ugc_submissions s JOIN ugc_snapshots r ON r.submission_id=s.id WHERE s.id=?`)
      .get(submission.id),
  ).toEqual({
    user_id: "author",
    revision: 1,
    id: submission.snapshotId,
    content: "Hello world",
    review_status: "pending_openai",
    moderation_queued_at: expect.any(String),
  });
  expect(bindings.autoModerationQueue.send).toHaveBeenCalledExactlyOnceWith({
    type: "moderation",
    submissionId: submission.id,
    snapshotId: submission.snapshotId,
    source: "upload",
    queuedAt: expect.any(String),
  });
  const mine = await createApp().request(
    "http://localhost/uploads/v1/comments/mine?markerId=marker-1",
    { headers },
    bindings.bindings,
  );
  expect(await mine.json()).toMatchObject({
    items: [{ id: submission.id, snapshotId: submission.snapshotId, content: "Hello world" }],
  });
  const otherMine = await createApp().request(
    "http://localhost/uploads/v1/comments/mine?markerId=marker-1",
    { headers: readerHeaders },
    bindings.bindings,
  );
  expect(otherMine.status).toBe(200);
  expect(await otherMine.json()).toMatchObject({ items: [] });
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
});

it("replies to the current public parent even when its frontier is pending, with no parent snapshot request", async () => {
  insertCommentSnapshot(database.sqlite, { id: "parent", userId: "reader", depth: 3 });
  database.sqlite.exec(`INSERT INTO ugc_snapshots
    (id,submission_id,kind,revision,content,review_status,creator_user_id)
    VALUES ('B','parent','comment',2,'Pending B','pending_audit','reader');
    UPDATE ugc_submissions SET revision=2 WHERE id='parent';`);
  const response = await post("/comments", { ...comment, parentId: "parent" });
  expect(response.status).toBe(200);
  const { submission } = (await response.json()) as { submission: { id: string } };
  expect(submission).toMatchObject({ parentId: "parent", depth: 4 });
  database.sqlite.exec("UPDATE ugc_submissions SET author_deleted_at='later' WHERE id='parent'");
  expect(
    database.sqlite.prepare("SELECT parent_id FROM ugc_submissions WHERE id=?").get(submission.id),
  ).toEqual({ parent_id: "parent" });
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
});

it.each(["deleted", "disabled", "rejected", "pending", "missing", "marker", "hash", "type"])(
  "rejects an unavailable or mismatched %s parent without identity, version or delivery",
  async (reason) => {
    if (reason !== "missing") {
      insertCommentSnapshot(database.sqlite, {
        id: "parent",
        userId: "reader",
        reviewStatus:
          ({ pending: "pending_openai", rejected: "rejected" } as const)[
            reason as "pending" | "rejected"
          ] ?? "approved",
      });
    }
    if (reason === "deleted") {
      database.sqlite.exec("UPDATE ugc_submissions SET author_deleted_at='gone' WHERE id='parent'");
    }
    if (reason === "disabled") {
      database.sqlite.exec(
        "UPDATE ugc_submissions SET admin_deleted_at='gone',admin_deleted_by='reader' WHERE id='parent'",
      );
    }
    if (["marker", "hash", "type"].includes(reason)) {
      database.sqlite.exec(
        `UPDATE ugc_submissions SET ${({ marker: "poi_id", hash: "poi_hash", type: "poi_type" } as Record<string, string>)[reason]}='different' WHERE id='parent'`,
      );
    }
    const before = database.sqlite.prepare("SELECT count(*) AS count FROM ugc_submissions").get();
    const response = await post("/comments", { ...comment, parentId: "parent" });
    expect(response.status).toBe(reason === "missing" ? 404 : 409);
    const mismatch = ["marker", "hash", "type"].includes(reason);
    const expectedCode = mismatch ? "PARENT_COMMENT_MISMATCH" : "PARENT_COMMENT_NOT_VISIBLE";
    expect(await response.json()).toMatchObject({
      code: reason === "missing" ? "PARENT_COMMENT_NOT_FOUND" : expectedCode,
    });
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM ugc_submissions").get()).toEqual(
      before,
    );
    expect(
      database.sqlite.prepare("SELECT * FROM ugc_snapshots WHERE creator_user_id='author'").all(),
    ).toEqual([]);
    expect(bindings.autoModerationQueue.send).not.toHaveBeenCalled();
  },
);

it("rolls identity back when snapshot persistence fails and gives retry fresh identities", async () => {
  let failedId: unknown;
  database.hooks.beforeQuery = (sql, values) => {
    if (/INSERT INTO ugc_snapshots/.test(sql)) {
      failedId = values[1];
      throw new Error("snapshot unavailable");
    }
  };
  expect((await post("/comments", comment)).status).toBe(500);
  expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual([]);
  expect(bindings.autoModerationQueue.send).not.toHaveBeenCalled();
  database.hooks.beforeQuery = undefined;
  const retry = await post("/comments", comment);
  expect(retry.status).toBe(200);
  const { submission } = (await retry.json()) as { submission: { id: string } };
  expect(submission.id).not.toBe(failedId);
});

it("retains a pending unmarked snapshot when external delivery fails", async () => {
  bindings.autoModerationQueue.send.mockRejectedValue(new Error("queue unavailable"));
  expect((await post("/comments", comment)).status).toBe(500);
  expect(
    database.sqlite.prepare("SELECT review_status,moderation_queued_at FROM ugc_snapshots").all(),
  ).toEqual([{ review_status: "pending_openai", moderation_queued_at: null }]);
});

it("toggles and reverses votes across public versions while preserving creation time", async () => {
  insertCommentSnapshot(database.sqlite, { id: "target", userId: "author" });
  for (const [action, previousVote, vote, score] of [
    ["upvote", 0, 1, 1],
    ["upvote", 1, 0, 0],
    ["downvote", 0, -1, -1],
    ["upvote", -1, 1, 1],
  ] as const) {
    const response = await post(`/comments/target/${action}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, previousVote, vote, score });
  }
  const original = database.sqlite.prepare("SELECT created_at FROM ugc_submission_votes").get();
  database.sqlite
    .exec(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,content,review_status,creator_user_id)
    VALUES ('new-public','target','comment',2,'Replacement','approved','author');
    UPDATE ugc_submissions SET revision=2 WHERE id='target';`);
  expect(await (await post("/comments/target/downvote")).json()).toEqual({
    ok: true,
    previousVote: 1,
    vote: -1,
    score: -1,
  });
  expect(database.sqlite.prepare("SELECT created_at FROM ugc_submission_votes").get()).toEqual(
    original,
  );
});

it.each(["pending_openai", "pending_audit", "rejected", "unknown"] as const)(
  "denies votes on a first version in %s",
  async (reviewStatus) => {
    insertCommentSnapshot(database.sqlite, { id: "target", userId: "reader", reviewStatus });
    expect((await post("/comments/target/upvote")).status).toBe(409);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submission_votes").all()).toEqual([]);
    expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
  },
);

it("keeps readers separate and notifies only committed positive votes, preserving vote timestamps", async () => {
  insertCommentSnapshot(database.sqlite, { id: "target", userId: "reader" });
  const fanout = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  bindings.bindings.OEM_NOTIFICATION_DO = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: fanout }),
  } as unknown as DurableObjectNamespace;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
  expect(await (await post("/comments/target/upvote")).json()).toMatchObject({ vote: 1, score: 1 });
  await Promise.all(pending);
  expect(fanout).toHaveBeenCalledTimes(1);
  expect(
    database.sqlite.prepare("SELECT recipient_user_id,message_count FROM notifications").all(),
  ).toEqual([{ recipient_user_id: "reader", message_count: 1 }]);
  vi.setSystemTime(new Date("2026-10-29T00:00:01.000Z"));
  expect(await (await post("/comments/target/upvote")).json()).toMatchObject({ vote: 0, score: 0 });
  expect(
    database.sqlite.prepare("SELECT active,created_at,updated_at FROM ugc_submission_votes").get(),
  ).toEqual({
    active: 0,
    created_at: "2026-10-29T00:00:00.000Z",
    updated_at: "2026-10-29T00:00:01.000Z",
  });
  vi.setSystemTime(new Date("2026-10-29T00:00:02.000Z"));
  expect(await (await post("/comments/target/downvote")).json()).toMatchObject({
    previousVote: 0,
    vote: -1,
    score: -1,
  });
  expect(
    database.sqlite.prepare("SELECT count(*) AS count FROM notification_messages").get(),
  ).toEqual({ count: 1 });
  headers = insertAuthenticatedUser(database.sqlite, { uid: "other-reader" }).headers;
  expect(await (await post("/comments/target/downvote")).json()).toMatchObject({
    previousVote: 0,
    vote: -1,
    score: -2,
  });
  expect(
    database.sqlite
      .prepare("SELECT user_id,value FROM ugc_submission_votes ORDER BY user_id")
      .all(),
  ).toEqual([
    { user_id: "author", value: -1 },
    { user_id: "other-reader", value: -1 },
  ]);
});

it("logs queue bookkeeping failure after successful delivery without failing creation", async () => {
  database.hooks.beforeQuery = (sql) => {
    if (/UPDATE ugc_snapshots SET moderation_queued_at/.test(sql)) {
      throw new Error("marker unavailable");
    }
  };
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect((await post("/comments", comment)).status).toBe(200);
  expect(bindings.autoModerationQueue.send).toHaveBeenCalledTimes(1);
  expect(database.sqlite.prepare("SELECT moderation_queued_at FROM ugc_snapshots").get()).toEqual({
    moderation_queued_at: null,
  });
  expect(warning).toHaveBeenCalledWith(
    "moderation queued marker update failed",
    expect.objectContaining({ error: "marker unavailable" }),
  );
  warning.mockRestore();
});

it("treats an image as neither a reply parent nor a comment vote target", async () => {
  insertImageSnapshot(database.sqlite, { id: "image", userId: "reader" });
  const reply = await post("/comments", { ...comment, parentId: "image" });
  expect(reply.status).toBe(404);
  expect(await reply.json()).toMatchObject({ code: "PARENT_COMMENT_NOT_FOUND" });
  const vote = await post("/comments/image/upvote");
  expect(vote.status).toBe(404);
  expect(await vote.json()).toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
  expect(database.sqlite.prepare("SELECT id FROM ugc_submissions").all()).toEqual([
    { id: "image" },
  ]);
  expect(bindings.autoModerationQueue.send).not.toHaveBeenCalled();
});

it("votes on public A while B is pending and refuses further changes when B is rejected", async () => {
  insertCommentSnapshot(database.sqlite, { id: "target", userId: "author" });
  expect((await post("/comments/target/upvote")).status).toBe(200);
  database.sqlite
    .exec(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,content,review_status,creator_user_id)
    VALUES ('B','target','comment',2,'Private B','pending_openai','author');
    UPDATE ugc_submissions SET revision=2 WHERE id='target';`);
  expect(await (await post("/comments/target/downvote")).json()).toEqual({
    ok: true,
    previousVote: 1,
    vote: -1,
    score: -1,
  });
  const before = database.sqlite.prepare("SELECT * FROM ugc_submission_votes").all();
  database.sqlite.exec("UPDATE ugc_snapshots SET review_status='rejected' WHERE id='B'");
  expect((await post("/comments/target/upvote")).status).toBe(409);
  expect(database.sqlite.prepare("SELECT * FROM ugc_submission_votes").all()).toEqual(before);
});

it("accepts a reply to a flagged public parent without notifying before approval", async () => {
  insertCommentSnapshot(database.sqlite, { id: "parent", userId: "reader", depth: 1 });
  database.sqlite.exec(
    "INSERT INTO ugc_submission_flags (submission_id,user_id,active) VALUES ('parent','author',1)",
  );
  const response = await post("/comments", { ...comment, parentId: "parent" });
  expect(response.status).toBe(200);
  const { submission } = (await response.json()) as {
    submission: { id: string; snapshotId: string };
  };
  expect(submission).toMatchObject({ parentId: "parent", depth: 2, status: "pending_openai" });
  expect(bindings.autoModerationQueue.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ submissionId: submission.id, snapshotId: submission.snapshotId }),
  );
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
});
