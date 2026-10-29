import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import {
  createImageLifecycleFixture,
  type ImageLifecycleFixture,
} from "@/test/fixtures/imageLifecycle";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";

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
let liveNotifications: ImageLifecycleFixture["liveNotifications"];

beforeEach(() => {
  ({ database, env, moderation, webhooks, liveNotifications, request } =
    createImageLifecycleFixture());
  importCurrentSubmissions(database);
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
  return request(`/images/${id}/${action}`, user, { snapshotId: `snapshot-${id}` });
}

function persistedState() {
  return [
    "ugc_submissions",
    "ugc_snapshots",
    "ugc_submission_upvotes",
    "ugc_submission_flags",
    "notifications",
    "notification_messages",
    "ugc_snapshots_review_audit",
  ].map((table) => database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

describe("image write permissions", () => {
  it.each(["pending_openai", "pending_audit", "rejected", "unknown"] as const)(
    "preserves a %s image when readers try to vote or flag it",
    async (status) => {
      insertImageSnapshot(database.sqlite, { id: "photo", userId: "author", reviewStatus: status });
      const before = persistedState();
      for (const action of ["upvote", "unvote", "flag", "unflag"]) {
        const response = await post("photo", action);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code:
            action === "flag" || action === "unflag"
              ? "PUBLIC_SNAPSHOT_CONFLICT"
              : "INVALID_SUBMISSION_STATUS",
        });
      }
      expect(persistedState()).toEqual(before);
      expect(webhooks).toEqual([]);
      expect(liveNotifications).toEqual([]);
    },
  );

  it.each(["upvote", "unvote", "flag", "unflag"])(
    "does not apply image %s to a missing item or a comment",
    async (action) => {
      insertCommentSnapshot(database.sqlite, { id: "comment", userId: "author" });
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
    insertImageSnapshot(database.sqlite, { id: "photo", userId: "author" });
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
    insertImageSnapshot(database.sqlite, { id: "photo", userId: "author" });
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

// Snapshot-schema votes and reports are covered in reportAndImageVoteLifecycle.spec.ts.

// Replaced recall/removal expectations: authorDeletion.spec.ts exercises logical DELETE and retired POST 404.
