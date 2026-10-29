import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createImageLifecycleFixture,
  type ImageLifecycleFixture,
} from "@/test/fixtures/imageLifecycle";
import { insertSubmission } from "@/test/fixtures/submissions";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: async () => ({ success: true }) } },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

let database: ImageLifecycleFixture["database"];
let env: ImageLifecycleFixture["env"];
let moderation: ImageLifecycleFixture["moderation"];
let webhooks: ImageLifecycleFixture["webhooks"];
let request: ImageLifecycleFixture["request"];
let submission: ImageLifecycleFixture["submission"];
let persistedState: ImageLifecycleFixture["persistedState"];
let liveNotifications: ImageLifecycleFixture["liveNotifications"];

beforeEach(() => {
  ({ database, env, moderation, webhooks, liveNotifications, request, submission, persistedState } =
    createImageLifecycleFixture());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  database.close();
});

function upload(
  file = new File([new Uint8Array([137, 80, 78, 71])], "entrance.png", { type: "image/png" }),
) {
  const form = new FormData();
  form.set("file", file);
  form.set("markerId", "marker-1");
  form.set("poiHash", "hash");
  form.set("poiType", "poi");
  form.set("content", "East entrance");
  return form;
}

function post(id: string, action: string, user = "reader") {
  return request(`/images/${id}/${action}`, user, {});
}

async function publicImage(user: string | null = null) {
  const response = await request("/images/photo?markerId=marker-1", user);
  expect(response.status).toBe(200);
  return ((await response.json()) as { item: Record<string, unknown> }).item;
}

function activeUsers(table: "ugc_submission_upvotes" | "ugc_submission_flags", id = "photo") {
  return database.sqlite
    .prepare(`SELECT user_id FROM ${table} WHERE submission_id = ? AND active = 1 ORDER BY user_id`)
    .all(id)
    .map((row) => row.user_id);
}

describe("image write permissions", () => {
  it.each(["pending_openai", "pending_audit", "stale"])(
    "preserves a %s image when readers try to vote or flag it",
    async (status) => {
      insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author", status });
      const before = persistedState();
      for (const action of ["upvote", "unvote", "flag", "unflag"]) {
        const response = await post("photo", action);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "INVALID_SUBMISSION_STATUS" });
      }
      expect(persistedState()).toEqual(before);
      expect(webhooks).toEqual([]);
      expect(liveNotifications).toEqual([]);
    },
  );

  it.each(["upvote", "unvote", "flag", "unflag"])(
    "does not apply image %s to a missing item or a comment",
    async (action) => {
      insertSubmission(database.sqlite, { id: "comment", userId: "author" });
      const before = persistedState();
      for (const id of ["missing", "comment"]) {
        const response = await post(id, action, "author");
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
      }
      expect(persistedState()).toEqual(before);
      expect(webhooks).toEqual([]);
      expect(moderation).toEqual([]);
      expect(liveNotifications).toEqual([]);
    },
  );

  it.each([
    {
      name: "an unauthenticated visitor",
      user: null,
      locked: false,
      status: 401,
      code: "SESSION_REQUIRED",
    },
    {
      name: "a suspended reader",
      user: "suspended",
      locked: false,
      status: 403,
      code: "ACCESS_DENIED",
    },
    {
      name: "a reader during an upload lock",
      user: "reader",
      locked: true,
      status: 503,
      code: "UPLOADS_TEMPORARILY_DISABLED",
    },
  ])("protects stored images and reactions from $name", async ({ user, locked, status, code }) => {
    insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author" });
    await post("photo", "upvote");
    await post("photo", "flag");
    if (locked) {
      env.LOCK_UPLOAD_ENDPOINTS = "true";
      vi.spyOn(console, "error").mockImplementation(() => {});
    }
    const before = persistedState();
    for (const action of ["upvote", "unvote", "flag", "unflag"]) {
      const response = await request(`/images/photo/${action}`, user, {});
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
    const uploadResponse = await request("/images", user, upload());
    expect(uploadResponse.status).toBe(status);
    expect(await uploadResponse.json()).toMatchObject({ code });
    expect(persistedState()).toEqual(before);
    // Permission rejection must happen before the R2 write adapter is reached.
    expect(env.UGC_BUCKET.put).not.toHaveBeenCalled();
    expect(moderation).toEqual([]);
    expect(webhooks).toHaveLength(1);
    expect(liveNotifications).toHaveLength(1);
  });

  it.each([
    ["flag", "author", "CANNOT_FLAG_OWN_SUBMISSION"],
    ["unflag", "author", "CANNOT_UNFLAG_OWN_SUBMISSION"],
  ])("rejects %s by %s without changing the image or its reactions", async (action, user, code) => {
    insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author" });
    await post("photo", "flag");
    const before = persistedState();
    const notices = webhooks.length;
    const response = await post("photo", action, user);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    expect(persistedState()).toEqual(before);
    expect(webhooks).toHaveLength(notices);
    expect(liveNotifications).toEqual([]);
    expect(moderation).toEqual([]);
  });
});

describe("image votes", () => {
  it("counts each reader once, isolates withdrawals, and lets a reader vote again", async () => {
    insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author" });
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
    expect(submission("photo").status).toBe("active");
    expect(moderation).toEqual([]);
  });
});

describe("image flags", () => {
  it("keeps the image flagged until the last reader withdraws and accepts a later flag again", async () => {
    insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author" });
    const first = await post("photo", "flag");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      created: true,
      status: "flagged",
      flagCount: 1,
    });
    expect(submission("photo").status).toBe("flagged");
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
    expect(submission("photo").status).toBe("flagged");
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
    expect(submission("photo").status).toBe("active");
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

// Replaced recall/removal expectations: authorDeletion.spec.ts exercises logical DELETE and retired POST 404.
