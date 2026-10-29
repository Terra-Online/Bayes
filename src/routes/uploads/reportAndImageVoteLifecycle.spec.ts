import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPublicSnapshot } from "@/repositories/submission/snapshotReads";
import type { UserSubmissionComment } from "@/repositories/submission/types";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import {
  createImageLifecycleFixture,
  type ImageLifecycleFixture,
} from "@/test/fixtures/imageLifecycle";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: vi.fn().mockResolvedValue({ success: true }) } },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

let database: ImageLifecycleFixture["database"];
let request: ImageLifecycleFixture["request"];
let env: ImageLifecycleFixture["env"];
let moderation: ImageLifecycleFixture["moderation"];
let webhooks: ImageLifecycleFixture["webhooks"];
let liveNotifications: ImageLifecycleFixture["liveNotifications"];

beforeEach(() => {
  ({ database, request, env, moderation, webhooks, liveNotifications } =
    createImageLifecycleFixture());
  importCurrentSubmissions(database);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
});

function post(id: string, action: string, user = "reader") {
  return request(`/images/${id}/${action}`, user, { snapshotId: `snapshot-${id}` });
}
async function publicImage(user: string | null = null) {
  const response = await request("/images/photo?markerId=marker-1", user);
  expect(response.status).toBe(200);
  return ((await response.json()) as { item: Record<string, unknown> }).item;
}
async function mine() {
  const response = await request("/comments/mine?markerId=marker-1", "author");
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: UserSubmissionComment[] }).items;
}
function activeUsers(table: "ugc_submission_upvotes" | "ugc_submission_flags", id = "photo") {
  return database.sqlite
    .prepare(`SELECT user_id FROM ${table} WHERE submission_id=? AND active=1 ORDER BY user_id`)
    .all(id)
    .map((row) => row.user_id);
}
function activeFlaggers(id: string) {
  return activeUsers("ugc_submission_flags", id);
}
function persistedState() {
  return [
    "ugc_submissions",
    "ugc_snapshots",
    "ugc_submission_flags",
    "notifications",
    "notification_messages",
    "ugc_snapshots_review_audit",
  ].map((table) => database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

// Retained lifecycle assertions now exercise immutable snapshots and derived status.
// Historical remove_request/stale storage is replaced by explicit rejected/unknown versions.
describe("comment flags", () => {
  const post = (path: string, user = "author") =>
    request(path, user, { snapshotId: "snapshot-target" });
  it("lets a reader flag a comment again after withdrawing their earlier flag", async () => {
    insertCommentSnapshot(database.sqlite, { id: "target", userId: "author" });
    await post("/comments/target/flag", "reader");
    await post("/comments/target/unflag", "reader");
    const response = await post("/comments/target/flag", "reader");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      created: true,
      status: "flagged",
      flagCount: 1,
    });
    expect((await getPublicSnapshot(database.db, "target"))?.status).toBe("flagged");
    expect(activeFlaggers("target")).toEqual(["reader"]);
    expect(webhooks.map((message) => message.event.type)).toEqual([
      "flag_created",
      "flag_removed",
      "flag_created",
    ]);
  });

  it("counts each reader once and restores the comment only after the last flag is withdrawn", async () => {
    insertCommentSnapshot(database.sqlite, { id: "target", userId: "author" });

    const flag = await post("/comments/target/flag", "reader");
    expect(flag.status).toBe(200);
    expect(await flag.json()).toEqual({ ok: true, created: true, status: "flagged", flagCount: 1 });
    expect((await getPublicSnapshot(database.db, "target"))?.status).toBe("flagged");
    expect(activeFlaggers("target")).toEqual(["reader"]);
    expect(webhooks).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "flag_created",
          actor: expect.objectContaining({ uid: "reader" }),
          submission: expect.objectContaining({ id: "target" }),
          previousStatus: "active",
          nextStatus: "flagged",
          flagCount: 1,
        }),
      }),
    ]);

    const duplicate = await post("/comments/target/flag", "reader");
    expect(await duplicate.json()).toEqual({
      ok: true,
      created: false,
      status: "flagged",
      flagCount: 1,
    });
    expect(activeFlaggers("target")).toEqual(["reader"]);
    expect(webhooks).toHaveLength(1);

    const second = await post("/comments/target/flag", "other-reader");
    expect(await second.json()).toMatchObject({ created: true, flagCount: 2 });
    expect(activeFlaggers("target")).toEqual(["other-reader", "reader"]);
    const withdrawn = await post("/comments/target/unflag", "reader");
    expect(await withdrawn.json()).toEqual({
      ok: true,
      deleted: true,
      status: "flagged",
      flagCount: 1,
    });
    expect(activeFlaggers("target")).toEqual(["other-reader"]);
    expect((await getPublicSnapshot(database.db, "target"))?.status).toBe("flagged");

    const absent = await post("/comments/target/unflag", "reader");
    expect(await absent.json()).toEqual({
      ok: true,
      deleted: false,
      status: "flagged",
      flagCount: 1,
    });
    expect(webhooks).toHaveLength(3);
    const last = await post("/comments/target/unflag", "other-reader");
    expect(await last.json()).toEqual({ ok: true, deleted: true, status: "active", flagCount: 0 });
    expect((await getPublicSnapshot(database.db, "target"))?.status).toBe("active");
    expect(activeFlaggers("target")).toEqual([]);
    expect(webhooks.at(-1)).toMatchObject({
      event: {
        type: "flag_removed",
        actor: { uid: "other-reader" },
        submission: { id: "target" },
        previousStatus: "flagged",
        nextStatus: "active",
        flagCount: 0,
      },
    });
    expect((await mine())[0]).toMatchObject({ id: "target", status: "active", flagCount: 0 });
    expect(moderation).toEqual([]);
  });

  it.each([
    ["flag", "CANNOT_FLAG_OWN_SUBMISSION"],
    ["unflag", "CANNOT_UNFLAG_OWN_SUBMISSION"],
  ])("prevents an author from attempting to %s their own comment", async (action, code) => {
    insertCommentSnapshot(database.sqlite, { id: "target", userId: "author" });
    await post("/comments/target/flag", "reader");
    const before = persistedState();
    const response = await post(`/comments/target/${action}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    expect(persistedState()).toEqual(before);
    expect(webhooks).toHaveLength(1);
  });

  it.each(["pending_openai", "pending_audit", "rejected", "unknown"] as const)(
    "does not accept or withdraw flags while a comment is %s",
    async (status) => {
      insertCommentSnapshot(database.sqlite, {
        id: "target",
        userId: "author",
        reviewStatus: status,
      });
      const before = persistedState();
      for (const action of ["flag", "unflag"]) {
        const response = await post(`/comments/target/${action}`, "reader");
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "PUBLIC_SNAPSHOT_CONFLICT" });
      }
      expect(persistedState()).toEqual(before);
      expect(webhooks).toEqual([]);
    },
  );
});

describe("image votes", () => {
  it("counts each reader once, isolates withdrawals, and lets a reader vote again", async () => {
    insertImageSnapshot(database.sqlite, {
      id: "photo",
      userId: "author",
      filePath: "prod/photo.webp",
    });
    const first = await post("photo", "upvote");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, created: true, upvoteCount: 1 });
    expect(activeUsers("ugc_submission_upvotes")).toEqual(["reader"]);
    expect(await publicImage("reader")).toMatchObject({ upvoteCount: 1, upvoted: true });
    expect(await publicImage("other-reader")).toMatchObject({ upvoteCount: 1, upvoted: false });
    expect(
      database.sqlite
        .prepare(
          "SELECT recipient_user_id, submission_id, category, message_count FROM notifications",
        )
        .all(),
    ).toEqual([
      {
        recipient_user_id: "author",
        submission_id: "photo",
        category: "community",
        message_count: 1,
      },
    ]);
    expect(liveNotifications).toEqual([
      expect.objectContaining({
        recipient: "author",
        body: expect.objectContaining({ event: "notification.upserted" }),
      }),
    ]);

    const duplicate = await post("photo", "upvote");
    expect(await duplicate.json()).toEqual({ ok: true, created: false, upvoteCount: 1 });
    expect(activeUsers("ugc_submission_upvotes")).toEqual(["reader"]);
    expect(liveNotifications).toHaveLength(1);
    const second = await post("photo", "upvote", "other-reader");
    expect(await second.json()).toEqual({ ok: true, created: true, upvoteCount: 2 });
    const withdrawn = await post("photo", "unvote");
    expect(await withdrawn.json()).toEqual({ ok: true, deleted: true, upvoteCount: 1 });
    expect(activeUsers("ugc_submission_upvotes")).toEqual(["other-reader"]);
    expect(await publicImage("reader")).toMatchObject({ upvoteCount: 1, upvoted: false });
    const repeatedWithdrawal = await post("photo", "unvote");
    expect(await repeatedWithdrawal.json()).toEqual({
      ok: true,
      deleted: false,
      upvoteCount: 1,
    });
    const renewedVote = await post("photo", "upvote");
    expect(await renewedVote.json()).toEqual({
      ok: true,
      created: true,
      upvoteCount: 2,
    });
    expect(activeUsers("ugc_submission_upvotes")).toEqual(["other-reader", "reader"]);
    expect((await getPublicSnapshot(database.db, "photo"))?.status).toBe("active");
    expect(moderation).toEqual([]);
  });
});

describe("image flags", () => {
  it("keeps the image flagged until the last reader withdraws and accepts a later flag again", async () => {
    insertImageSnapshot(database.sqlite, {
      id: "photo",
      userId: "author",
      filePath: "prod/photo.webp",
    });
    const first = await post("photo", "flag");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      created: true,
      status: "flagged",
      flagCount: 1,
    });
    expect((await getPublicSnapshot(database.db, "photo"))?.status).toBe("flagged");
    expect(await publicImage("reader")).toMatchObject({ flagCount: 1, flagged: true });
    expect(await publicImage("other-reader")).toMatchObject({ flagCount: 1, flagged: false });
    const duplicateFlag = await post("photo", "flag");
    expect(await duplicateFlag.json()).toEqual({
      ok: true,
      created: false,
      status: "flagged",
      flagCount: 1,
    });
    expect(activeUsers("ugc_submission_flags")).toEqual(["reader"]);
    expect(webhooks).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "flag_created",
          actor: expect.objectContaining({ uid: "reader" }),
          submission: expect.objectContaining({ id: "photo", kind: "image" }),
          previousStatus: "active",
          nextStatus: "flagged",
          flagCount: 1,
        }),
      }),
    ]);

    const secondFlag = await post("photo", "flag", "other-reader");
    expect(await secondFlag.json()).toMatchObject({
      flagCount: 2,
    });
    const withdrawnFlag = await post("photo", "unflag");
    expect(await withdrawnFlag.json()).toEqual({
      ok: true,
      deleted: true,
      status: "flagged",
      flagCount: 1,
    });
    expect((await getPublicSnapshot(database.db, "photo"))?.status).toBe("flagged");
    expect(activeUsers("ugc_submission_flags")).toEqual(["other-reader"]);
    const repeatedWithdrawal = await post("photo", "unflag");
    expect(await repeatedWithdrawal.json()).toMatchObject({
      deleted: false,
      flagCount: 1,
    });
    expect(webhooks).toHaveLength(3);
    const lastWithdrawal = await post("photo", "unflag", "other-reader");
    expect(await lastWithdrawal.json()).toEqual({
      ok: true,
      deleted: true,
      status: "active",
      flagCount: 0,
    });
    expect((await getPublicSnapshot(database.db, "photo"))?.status).toBe("active");
    expect(activeUsers("ugc_submission_flags")).toEqual([]);
    expect(await publicImage("reader")).toMatchObject({
      status: "active",
      flagCount: 0,
      flagged: false,
    });
    expect(webhooks.at(-1)).toMatchObject({
      event: {
        type: "flag_removed",
        previousStatus: "flagged",
        nextStatus: "active",
        flagCount: 0,
      },
    });
    const renewedFlag = await post("photo", "flag");
    expect(await renewedFlag.json()).toMatchObject({
      created: true,
      flagCount: 1,
    });
    expect(activeUsers("ugc_submission_flags")).toEqual(["reader"]);
    expect(moderation).toEqual([]);
  });
});

it.each(["comment", "image"] as const)(
  "preserves auth, suspension and upload-lock policy for %s reactions",
  async (kind) => {
    const insert = kind === "comment" ? insertCommentSnapshot : insertImageSnapshot;
    insert(database.sqlite, { id: "target", userId: "author" });
    const prefix = kind === "comment" ? "comments" : "images";
    const actions =
      kind === "comment" ? ["flag", "unflag"] : ["flag", "unflag", "upvote", "unvote"];
    const before = persistedState();
    for (const action of actions) {
      const anonymous = await request(`/${prefix}/target/${action}`, null, {
        snapshotId: "snapshot-target",
      });
      expect(anonymous.status).toBe(401);
      const suspended = await request(`/${prefix}/target/${action}`, "suspended", {
        snapshotId: "snapshot-target",
      });
      expect(suspended.status).toBe(403);
    }
    env.LOCK_UPLOAD_ENDPOINTS = "true";
    for (const action of actions) {
      const locked = await request(`/${prefix}/target/${action}`, "reader", {
        snapshotId: "snapshot-target",
      });
      expect(locked.status).toBe(503);
    }
    expect(persistedState()).toEqual(before);
    expect(webhooks).toEqual([]);
    expect(liveNotifications).toEqual([]);
  },
);
