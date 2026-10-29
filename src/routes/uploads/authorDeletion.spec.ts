import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { getReviewTarget, reviewSnapshot } from "@/repositories/submission/reviewSnapshot";
import { getOwnerSnapshot } from "@/repositories/submission/snapshotReads";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type SessionHeaders } from "@/test/fixtures/auth";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
const { cache } = vi.hoisted(() => ({ cache: { purgeMarker: vi.fn() } }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: cache },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    zremrangebyscore = vi.fn().mockResolvedValue(0);
    zcard = vi.fn().mockResolvedValue(0);
    zadd = vi.fn().mockResolvedValue(1);
    expire = vi.fn().mockResolvedValue(1);
  },
}));
let database: TestDatabase;
let mocks: MockBindings;
let author: SessionHeaders;
let admin: SessionHeaders;
beforeEach(() => {
  vi.resetAllMocks();
  cache.purgeMarker.mockResolvedValue({ success: true });
  database = createTestDatabase();
  author = insertAuthenticatedUser(database.sqlite, { uid: "author" }).headers;
  admin = insertAuthenticatedUser(database.sqlite, { uid: "admin", role: "a" }).headers;
  importCurrentSubmissions(database);
  mocks = createMockBindings({ DB: database.db });
  mocks.bindings.LOCK_UPLOAD_ENDPOINTS = "false";
  mocks.bindings.UGC_UPLOAD_TEST_PREFIX = "";
  mocks.authRateLimit.limit.mockResolvedValue({ success: true });
  mocks.publicRateLimit.limit.mockResolvedValue({ success: true });
});
afterEach(() => database.close());
async function request(path: string, method = "DELETE", headers: Record<string, string> = author) {
  const pending: Promise<unknown>[] = [];
  const response = await runWithAuthRequest(() =>
    createApp().request(`http://localhost/uploads/v1${path}`, { method, headers }, mocks.bindings, {
      waitUntil: (task: Promise<unknown>) => pending.push(task),
    } as unknown as ExecutionContext),
  );
  await Promise.all(pending);
  return response;
}
function seed(kind: "comment" | "image", reviewStatus: "approved" | "pending_openai" = "approved") {
  (kind === "comment" ? insertCommentSnapshot : insertImageSnapshot)(database.sqlite, {
    id: "target",
    userId: "author",
    reviewStatus,
  });
  database.sqlite.exec(
    "INSERT INTO ugc_submission_flags(submission_id,user_id,active) VALUES ('target','admin',1)",
  );
}
it.each(["comment", "image"] as const)(
  "logically deletes an owned %s once, preserves disabled facts, snapshots and flags, and keeps the owner archive",
  async (kind) => {
    seed(kind);
    database.sqlite.exec(
      "UPDATE ugc_submissions SET admin_deleted_at='disabled',admin_deleted_by='admin'",
    );
    const path = `/${kind}s/target`;
    const first = await request(path);
    expect(first.status).toBe(200);
    const payload = await first.json();
    expect(payload).toMatchObject({ ok: true, authorDeletedAt: expect.any(String) });
    expect((await request(path)).status).toBe(200);
    expect(await (await request(path)).json()).toEqual(payload);
    expect(
      database.sqlite
        .prepare(
          "SELECT author_deleted_at,admin_deleted_at,admin_deleted_by,revision FROM ugc_submissions WHERE id='target'",
        )
        .get(),
    ).toEqual({
      author_deleted_at: (payload as { authorDeletedAt: string }).authorDeletedAt,
      admin_deleted_at: "disabled",
      admin_deleted_by: "admin",
      revision: 1,
    });
    expect(
      await getOwnerSnapshot(database.db, { id: "target", ownerUserId: "author" }),
    ).toMatchObject({ id: "target", snapshotId: "snapshot-target" });
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM ugc_snapshots").get()).toEqual({
      count: 1,
    });
    expect(database.sqlite.prepare("SELECT active FROM ugc_submission_flags").get()).toEqual({
      active: 1,
    });
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM notifications").get()).toEqual({
      count: 0,
    });
    expect(cache.purgeMarker).toHaveBeenCalledTimes(1);
    expect(mocks.autoModerationQueue.send).not.toHaveBeenCalled();
    expect(mocks.ugcBucket.delete).not.toHaveBeenCalled();
    expect(mocks.webhookQueue.send).not.toHaveBeenCalled();
    expect((await request(`/${kind}s/target?markerId=marker-1`, "GET")).status).toBe(404);
    if (kind === "image") {
      expect((await request("/public-file/images/target.webp", "GET")).status).toBe(404);
      expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
      expect(mocks.ugcBucket.head).not.toHaveBeenCalled();
    }
    const archive = await request(`/${kind}s/mine?markerId=marker-1`, "GET");
    expect(archive.status).toBe(200);
    expect(await archive.json()).toMatchObject({
      items: [{ id: "target", snapshotId: "snapshot-target", status: "stale" }],
    });
  },
);
it.each(["comment", "image"] as const)(
  "requires the %s author even for administrators and rejects wrong kind/missing identities",
  async (kind) => {
    seed(kind);
    expect((await request(`/${kind}s/target`, "DELETE", {})).status).toBe(401);
    expect((await request(`/${kind}s/target`, "DELETE", admin)).status).toBe(403);
    expect((await request(`/${kind}s/missing`)).status).toBe(404);
    expect((await request(`/${kind === "comment" ? "images" : "comments"}/target`)).status).toBe(
      404,
    );
    expect(database.sqlite.prepare("SELECT author_deleted_at FROM ugc_submissions").get()).toEqual({
      author_deleted_at: null,
    });
  },
);
it.each(["comment", "image"] as const)(
  "deletion of a %s defeats an already selected review; review first retains its notifications",
  async (kind) => {
    seed(kind, "pending_openai");
    const target = (await getReviewTarget(database.db, "target", "snapshot-target"))!;
    const command = {
      target,
      expectedReviewStatus: "pending_openai" as const,
      source: "ai" as const,
      decision: "approved" as const,
      auditId: "late",
    };
    expect((await request(`/${kind}s/target`)).status).toBe(200);
    expect(await reviewSnapshot(database.db, command)).toEqual({ outcome: "ignored" });
    expect(
      database.sqlite.prepare("SELECT count(*) AS count FROM ugc_snapshots_review_audit").get(),
    ).toEqual({ count: 0 });
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM notifications").get()).toEqual({
      count: 0,
    });
    (kind === "comment" ? insertCommentSnapshot : insertImageSnapshot)(database.sqlite, {
      id: "reviewed",
      userId: "author",
      reviewStatus: "pending_openai",
    });
    const reviewed = (await getReviewTarget(database.db, "reviewed", "snapshot-reviewed"))!;
    expect(
      await reviewSnapshot(database.db, { ...command, target: reviewed, auditId: "first" }),
    ).toMatchObject({ outcome: "committed", firstApproval: true });
    const notifications = database.sqlite.prepare("SELECT * FROM notifications").all();
    expect((await request(`/${kind}s/reviewed`)).status).toBe(200);
    expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual(notifications);
    expect(
      database.sqlite.prepare("SELECT count(*) AS count FROM ugc_public_submissions").get(),
    ).toEqual({ count: 0 });
  },
);
it("retains children when deleting a comment and rejects new replies and edits", async () => {
  seed("comment");
  insertCommentSnapshot(database.sqlite, {
    id: "child",
    userId: "admin",
    parentId: "target",
    depth: 1,
  });
  expect((await request("/comments/target")).status).toBe(200);
  expect(
    database.sqlite.prepare("SELECT parent_id FROM ugc_submissions WHERE id='child'").get(),
  ).toEqual({ parent_id: "target" });
  expect((await request("/comments/target?markerId=marker-1", "GET")).status).toBe(404);
  const edit = await runWithAuthRequest(() =>
    createApp().request(
      "http://localhost/uploads/v1/comments/target/edit",
      {
        method: "POST",
        headers: { ...author, "content-type": "application/json" },
        body: JSON.stringify({ content: "changed", parentSnapshotId: "snapshot-target" }),
      },
      mocks.bindings,
    ),
  );
  expect(edit.status).toBe(409);
  const reply = await runWithAuthRequest(() =>
    createApp().request(
      "http://localhost/uploads/v1/comments",
      {
        method: "POST",
        headers: { ...author, "content-type": "application/json" },
        body: JSON.stringify({
          markerId: "marker-1",
          poiHash: "hash",
          poiType: "poi",
          content: "Late reply",
          parentId: "target",
        }),
      },
      mocks.bindings,
    ),
  );
  expect(reply.status).toBe(409);
  expect(await reply.json()).toMatchObject({ code: "PARENT_COMMENT_NOT_VISIBLE" });
});
it.each([
  "/comments/target/recall",
  "/comments/target/remove-request",
  "/images/target/recall",
  "/images/target/remove-request",
  "/images/target/unrecall",
])("retires POST %s with an unmatched 404", async (path) => {
  expect((await request(path, "POST")).status).toBe(404);
  expect((await request(path, "POST", {})).status).toBe(404);
});
