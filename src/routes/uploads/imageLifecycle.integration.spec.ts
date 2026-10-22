import { getRandom } from "@cloudflare/containers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import type {
  OemModerationQueueMessage,
  OemWebhookQueueMessage,
} from "@/services/moderation/messages";
import type { oem_imgTrans } from "@/services/upload/imageTranscoderContainer";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let env: AppEnv["Bindings"];
let sessions: Record<string, { authorization: string }>;
let moderation: OemModerationQueueMessage[];
let webhooks: OemWebhookQueueMessage[];
let liveNotifications: Array<{ recipient: string; body: unknown }>;
type StoredImage = { bytes: Uint8Array; options: R2PutOptions };
let storage: Map<string, StoredImage>;
const transformedImage = new Uint8Array([82, 73, 70, 70, 4, 5, 6]);
const transform = vi.fn();

beforeEach(() => {
  database = createTestDatabase();
  sessions = {};
  for (const [uid, role] of [
    ["author", "n"],
    ["reader", "n"],
    ["other-reader", "n"],
    ["admin", "a"],
    ["suspended", "s"],
  ]) {
    insertUser(database.sqlite, { uid, role });
    insertAuthUser(database.sqlite, { id: uid });
    sessions[uid] = insertSession(database.sqlite, { userId: uid }).headers;
  }
  storage = new Map();
  moderation = [];
  webhooks = [];
  liveNotifications = [];
  transform.mockReset().mockImplementation(
    async () =>
      new Response(transformedImage, {
        headers: { "content-type": "image/webp", "X-Converted-To-Webp": "true" },
      }),
  );
  vi.mocked(getRandom).mockResolvedValue({
    fetch: transform,
  } as unknown as DurableObjectStub<oem_imgTrans>);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  env = {
    ...testAuthConfig,
    DB: database.db,
    LOCK_UPLOAD_ENDPOINTS: "false",
    UGC_UPLOAD_TEST_PREFIX: "",
    UGC_ASSET_BASE_URL: "https://assets.example.test",
    OEM_PUBLIC_RATE_LIMIT: { limit: async () => ({ success: true }) },
    OEM_AUTH_RATE_LIMIT: { limit: async () => ({ success: true }) },
    UGC_BUCKET: {
      put: async (key: string, body: ArrayBuffer, options: R2PutOptions) => {
        storage.set(key, { bytes: new Uint8Array(body), options });
      },
      get: async (key: string) => {
        const image = storage.get(key);
        return image
          ? {
              body: image.bytes,
              httpEtag: '"test-image"',
              httpMetadata: image.options.httpMetadata,
              writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/webp"),
            }
          : null;
      },
    },
    OEM_MODERATION_Q: {
      send: async (message: OemModerationQueueMessage) => {
        moderation.push(message);
      },
    },
    OEM_WEBHOOK_Q: {
      send: async (message: OemWebhookQueueMessage) => {
        webhooks.push(message);
      },
    },
    OEM_NOTIFICATION_DO: {
      idFromName: (recipient: string) => recipient,
      get: (recipient: string) => ({
        fetch: async (_url: string, init: RequestInit) => {
          liveNotifications.push({ recipient, body: JSON.parse(String(init.body)) });
          return new Response(null, { status: 204 });
        },
      }),
    },
  } as unknown as AppEnv["Bindings"];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  database.close();
});

async function request(path: string, user: string | null = "author", body?: FormData | object) {
  const app = createRoutes();
  app.onError(onAppError);
  const pending: Promise<unknown>[] = [];
  const multipart = body instanceof FormData;
  const response = await app.request(
    `http://localhost${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...((user && sessions[user]) || {}),
        ...(multipart ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    },
    env,
    { waitUntil: (work: Promise<unknown>) => pending.push(work) } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
  return response;
}

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

function submission(id: string) {
  return database.sqlite.prepare("SELECT * FROM ugc_submissions WHERE id = ?").get(id)!;
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

function persistedState() {
  return {
    submissions: database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all(),
    votes: database.sqlite
      .prepare("SELECT * FROM ugc_submission_upvotes ORDER BY submission_id, user_id")
      .all(),
    flags: database.sqlite
      .prepare("SELECT * FROM ugc_submission_flags ORDER BY submission_id, user_id")
      .all(),
    notifications: database.sqlite.prepare("SELECT * FROM notifications ORDER BY id").all(),
    messages: database.sqlite.prepare("SELECT * FROM notification_messages ORDER BY id").all(),
    reviews: database.sqlite.prepare("SELECT * FROM ugc_review_events ORDER BY id").all(),
  };
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
    expect(storage.size).toBe(0);
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

describe("image removal requests", () => {
  it.each([false, true])(
    "keeps an image visible during removal review and restores its remaining flags on cancellation (flagged: %s)",
    async (flagged) => {
      insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author" });
      if (flagged) {
        await post("photo", "flag");
      }
      const response = await post("photo", "remove-request", "author");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, status: "remove_request" });
      expect(submission("photo").status).toBe("remove_request");
      expect(await publicImage()).toMatchObject({
        status: "remove_request",
        flagCount: flagged ? 1 : 0,
      });
      expect(webhooks.at(-1)).toMatchObject({
        event: {
          type: "remove_request_created",
          actor: { uid: "author" },
          submission: { id: "photo" },
          previousStatus: flagged ? "flagged" : "active",
          nextStatus: "remove_request",
        },
      });
      // Removal review does not hide the image or disable ordinary voting.
      const voteDuringReview = await post("photo", "upvote");
      expect(await voteDuringReview.json()).toMatchObject({
        created: true,
        upvoteCount: 1,
      });
      const withdrawnVote = await post("photo", "unvote");
      expect(await withdrawnVote.json()).toMatchObject({
        deleted: true,
        upvoteCount: 0,
      });
      const beforeRetry = submission("photo");
      const events = webhooks.length;
      const retry = await post("photo", "remove-request", "author");
      expect(retry.status).toBe(409);
      expect(submission("photo")).toEqual(beforeRetry);
      expect(webhooks).toHaveLength(events);
      const cancelled = await post("photo", "unrecall", "author");
      const restored = flagged ? "flagged" : "active";
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({
        ok: true,
        status: restored,
        flagCount: flagged ? 1 : 0,
      });
      expect(submission("photo").status).toBe(restored);
      expect(activeUsers("ugc_submission_flags")).toEqual(flagged ? ["reader"] : []);
      expect(await publicImage()).toMatchObject({ status: restored });
      expect(webhooks.at(-1)).toMatchObject({
        event: {
          type: "remove_request_cancelled",
          actor: { uid: "author" },
          previousStatus: "remove_request",
          nextStatus: restored,
          flagCount: flagged ? 1 : 0,
        },
      });
      expect(moderation).toEqual([]);
    },
  );
});

describe("image recall", () => {
  it.each(["pending_openai", "pending_audit", "active", "flagged", "remove_request"])(
    "withdraws a %s image from public and author lists and records one resolution even when retried",
    async (status) => {
      insertSubmission(database.sqlite, { id: "photo", kind: "image", userId: "author", status });
      const response = await post("photo", "recall", "author");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, status: "stale" });
      expect(submission("photo")).toMatchObject({
        status: "stale",
        file_path: "images/photo.webp",
        snapshot_id: "snapshot-photo",
      });
      expect((await request("/images/photo?markerId=marker-1", null)).status).toBe(404);
      const authorList = await request("/images/mine?markerId=marker-1");
      expect(await authorList.json()).toEqual({ items: [] });
      expect(
        database.sqlite
          .prepare(
            "SELECT from_status, to_status, source FROM ugc_review_events WHERE submission_id = 'photo'",
          )
          .all(),
      ).toEqual([{ from_status: status, to_status: "stale", source: "user_action" }]);
      expect(
        database.sqlite
          .prepare(
            "SELECT recipient_user_id, type, submission_id, message_count FROM notifications",
          )
          .all(),
      ).toEqual([
        {
          recipient_user_id: "author",
          type: "system.remove_request.resolved",
          submission_id: "photo",
          message_count: 1,
        },
      ]);
      expect(liveNotifications).toEqual([
        expect.objectContaining({
          recipient: "author",
          body: expect.objectContaining({
            event: "notification.upserted",
            notification: expect.objectContaining({
              target: expect.objectContaining({ submissionId: "photo", markerId: "marker-1" }),
            }),
          }),
        }),
      ]);
      const recalled = submission("photo");
      const retry = await post("photo", "recall", "author");
      expect(await retry.json()).toEqual({ ok: true, status: "stale" });
      expect(submission("photo")).toEqual(recalled);
      expect(
        database.sqlite.prepare("SELECT COUNT(*) AS count FROM ugc_review_events").get(),
      ).toEqual({ count: 1 });
      expect(
        database.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_messages").get(),
      ).toEqual({ count: 1 });
      expect(liveNotifications).toHaveLength(1);
      expect(moderation).toEqual([]);
      expect(webhooks).toEqual([]);
    },
  );
});

describe("stored image delivery", () => {
  it.each([
    { mimeType: "image/jpeg", contentType: "image/jpeg" },
    { mimeType: null, contentType: "application/octet-stream" },
  ])(
    "serves legacy file metadata safely through mounted public and private paths: $contentType",
    async ({ mimeType, contentType }) => {
      const filePath = "images/old photo.jpg";
      insertSubmission(database.sqlite, {
        id: "legacy-image",
        userId: "author",
        kind: "image",
        filePath,
        mimeType,
      });
      const before = persistedState();
      const app = new Hono<AppEnv>().onError(onAppError).route("/uploads/v1", createRoutes());
      const read = (path: string, headers?: Record<string, string>) =>
        app.request(
          `http://localhost/uploads/v1/${path}/${encodeURIComponent(filePath)}`,
          { headers },
          env,
        );
      for (const [path, headers] of [
        ["public-file", undefined],
        ["file", sessions.author],
      ] as const) {
        const missing = await read(path, headers);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({ code: "IMAGE_NOT_FOUND" });
      }
      storage.set(filePath, { bytes: transformedImage, options: {} });
      for (const [path, headers] of [
        ["public-file", undefined],
        ["file", sessions.author],
      ] as const) {
        const response = await read(path, headers);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(contentType);
        expect(response.headers.get("etag")).toBe('"test-image"');
        expect(response.headers.get("cache-control")).toMatch(
          path === "public-file" ? /^public, max-age=\d+, immutable$/ : /^private, max-age=\d+$/,
        );
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(transformedImage);
      }
      expect(persistedState()).toEqual(before);
      expect(moderation).toEqual([]);
    },
  );

  it.each(["public-file", "file"])(
    "rejects unsafe and malformed encoded %s paths before object storage is read",
    async (path) => {
      const getObject = vi
        .fn<R2Bucket["get"]>()
        .mockRejectedValue(new Error("Unexpected storage access"));
      env.UGC_BUCKET.get = getObject;
      const app = new Hono<AppEnv>().onError(onAppError).route("/uploads/v1", createRoutes());
      for (const key of [
        "%2Fprivate.webp",
        "%2E%2E%2Fprivate.webp",
        "images%5Cprivate.webp",
        "%ZZ",
      ]) {
        const response = await app.request(
          `http://localhost/uploads/v1/${path}/${key}`,
          { headers: sessions.author },
          env,
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      }
      expect(getObject).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual([]);
    },
  );
});

describe("image submission", () => {
  it("does not create a pending submission or moderation job when object storage fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storeImage = env.UGC_BUCKET.put;
    env.UGC_BUCKET.put = vi
      .fn<R2Bucket["put"]>()
      .mockRejectedValue(new Error("storage unavailable"));
    const response = await request("/images", "author", upload());
    expect(response.status).toBe(500);
    expect(storage.size).toBe(0);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual([]);
    expect(moderation).toEqual([]);
    env.UGC_BUCKET.put = storeImage;
    const retry = await request("/images", "author", upload());
    expect(retry.status).toBe(200);
    const payload = (await retry.json()) as { submission: { id: string; filePath: string } };
    expect(storage.size).toBe(1);
    expect(storage.has(payload.submission.filePath)).toBe(true);
    expect(database.sqlite.prepare("SELECT id, status FROM ugc_submissions").all()).toEqual([
      { id: payload.submission.id, status: "pending_openai" },
    ]);
    expect(moderation).toEqual([expect.objectContaining({ submissionId: payload.submission.id })]);
  });

  it.each([
    {
      name: "image processing rejects the source",
      upstreamStatus: 422,
      status: 422,
      code: "IMAGE_PROCESSING_FAILED",
    },
    {
      name: "the image service is unavailable",
      upstreamStatus: 500,
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    },
    {
      name: "processing makes the image too large",
      upstreamStatus: 200,
      status: 422,
      code: "UPLOAD_SIZE_INVALID",
    },
  ])(
    "leaves no stored image or pending submission when $name",
    async ({ upstreamStatus, status, code }) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      env.MAX_UPLOAD_BYTES = "6";
      transform.mockImplementation(
        async () =>
          new Response(transformedImage, {
            status: upstreamStatus,
            headers: { "content-type": "image/webp" },
          }),
      );
      const response = await request("/images", "author", upload());
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(storage.size).toBe(0);
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual([]);
      expect(moderation).toEqual([]);
    },
  );

  it.each([
    { name: "a missing file", mime: null, size: 1, code: "UPLOAD_FILE_MISSING" },
    { name: "an unsupported file", mime: "text/plain", size: 1, code: "MIME_NOT_ALLOWED" },
    { name: "an empty image", mime: "image/webp", size: 0, code: "UPLOAD_SIZE_INVALID" },
    { name: "an oversized image", mime: "image/webp", size: 9, code: "UPLOAD_SIZE_INVALID" },
  ])(
    "rejects $name without storing a file or creating a submission",
    async ({ mime, size, code }) => {
      env.MAX_UPLOAD_BYTES = "8";
      const form = upload(
        new File([new Uint8Array(size)], "entrance", { type: mime ?? "image/webp" }),
      );
      if (mime === null) {
        form.delete("file");
      }
      const response = await request("/images", "author", form);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code });
      expect(storage.size).toBe(0);
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual([]);
      expect(moderation).toEqual([]);
    },
  );

  it.each(["image/webp", "image/avif"])(
    "preserves an already compressed %s upload and warns about another image at the same marker",
    async (mime) => {
      insertSubmission(database.sqlite, { id: "existing", userId: "reader", kind: "image" });
      const bytes = new Uint8Array([1, 2, 3]);
      const response = await request(
        "/images",
        "author",
        upload(new File([bytes], "entrance", { type: mime })),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { submission: { id: string; filePath: string } };
      expect(payload).toMatchObject({
        duplicatePoi: {
          markerId: "marker-1",
          imageCount: 2,
          dashboardPath: "/ugc-review?duplicateMarker=marker-1",
        },
      });
      expect(submission(payload.submission.id)).toMatchObject({
        mime_type: mime,
        size_bytes: 3,
        status: "pending_openai",
      });
      expect(storage.get(payload.submission.filePath)).toMatchObject({
        bytes,
        options: { customMetadata: { sourceMimeType: mime, convertedToWebp: "false" } },
      });
      expect(moderation).toEqual([
        expect.objectContaining({ submissionId: payload.submission.id }),
      ]);
    },
  );

  it("stores the processed image as a private pending submission and queues its moderation version", async () => {
    const response = await request("/images", "author", upload());
    expect(response.status).toBe(200);
    const { submission: created, duplicatePoi } = (await response.json()) as {
      submission: { id: string; snapshotId: string; filePath: string };
      duplicatePoi: unknown;
    };
    expect(duplicatePoi).toBeNull();
    expect(submission(created.id)).toMatchObject({
      kind: "image",
      user_id: "author",
      poi_id: "marker-1",
      poi_hash: "hash",
      poi_type: "poi",
      content: "East entrance",
      status: "pending_openai",
      file_path: created.filePath,
      snapshot_id: created.snapshotId,
      mime_type: "image/webp",
      size_bytes: 7,
    });
    expect(storage.get(created.filePath)).toEqual({
      bytes: transformedImage,
      options: {
        httpMetadata: {
          contentType: "image/webp",
          cacheControl: expect.stringMatching(/^public, max-age=\d+, immutable$/),
        },
        customMetadata: { sourceMimeType: "image/png", convertedToWebp: "true" },
      },
    });
    expect(moderation).toEqual([
      expect.objectContaining({
        type: "moderation",
        submissionId: created.id,
        snapshotId: created.snapshotId,
        source: "upload",
      }),
    ]);
    const mine = await request("/images/mine?markerId=marker-1");
    expect(await mine.json()).toMatchObject({
      items: [expect.objectContaining({ id: created.id, status: "pending_openai" })],
    });
    expect((await request(`/images/${created.id}?markerId=marker-1`, null)).status).toBe(404);
    expect((await request(`/public-file/${created.filePath}`, null)).status).toBe(404);
    const privateFile = await request(`/file/${created.filePath}`);
    expect(privateFile.status).toBe(200);
    expect(new Uint8Array(await privateFile.arrayBuffer())).toEqual(transformedImage);
    expect((await request(`/file/${created.filePath}`, "reader")).status).toBe(404);
    expect(webhooks).toEqual([]);
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
