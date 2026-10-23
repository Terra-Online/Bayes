import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createImageLifecycleFixture,
  type ImageLifecycleFixture,
} from "@/test/fixtures/imageLifecycle";
import { insertSubmission } from "@/test/fixtures/submissions";

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

describe("image write permissions", () => {
  it.each(["pending_openai", "pending_audit", "stale"])(
    "preserves a %s image when readers try to vote or flag it or the owner requests removal",
    async (status) => {
      insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author", status });
      const before = persistedState();
      for (const action of ["upvote", "unvote", "flag", "unflag"]) {
        const response = await post("photo", action);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "INVALID_SUBMISSION_STATUS" });
      }
      for (const action of ["remove-request", "unrecall"]) {
        const response = await post("photo", action, "author");
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
      }
      expect(persistedState()).toEqual(before);
      expect(webhooks).toEqual([]);
      expect(liveNotifications).toEqual([]);
    },
  );

  it("keeps existing flags during removal review and cannot cancel an image with no removal request", async () => {
    insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author" });
    const notRequested = await post("photo", "unrecall", "author");
    expect(notRequested.status).toBe(409);
    expect(submission("photo").status).toBe("active");
    await post("photo", "flag");
    await post("photo", "remove-request", "author");
    const before = persistedState();
    for (const action of ["flag", "unflag"]) {
      const response = await post("photo", action);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "INVALID_SUBMISSION_STATUS" });
    }
    expect(persistedState()).toEqual(before);
    expect(webhooks).toHaveLength(2);
  });

  it.each(["upvote", "unvote", "flag", "unflag", "recall", "unrecall", "remove-request"])(
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
    for (const action of [
      "upvote",
      "unvote",
      "flag",
      "unflag",
      "recall",
      "unrecall",
      "remove-request",
    ]) {
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
    ["recall", "reader", "RECALL_OWNER_ONLY"],
    ["recall", "admin", "RECALL_OWNER_ONLY"],
    ["unrecall", "reader", "RECALL_OWNER_ONLY"],
    ["remove-request", "reader", "REMOVE_REQUEST_OWNER_ONLY"],
    ["remove-request", "admin", "REMOVE_REQUEST_OWNER_ONLY"],
  ])("rejects %s by %s without changing the image or its reactions", async (action, user, code) => {
    insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author" });
    await post("photo", "flag");
    if (action === "unrecall") {
      await post("photo", "remove-request", "author");
    }
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

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: async () => ({ success: true }) } },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async zremrangebyscore() {}
    async zcard() {
      return 0;
    }
    async zadd() {}
    async expire() {}
  },
}));
