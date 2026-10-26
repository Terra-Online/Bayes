import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import type { AutoModerationMsg, WebhookMsg } from "@/queues/types/messages";
import type { UserSubmissionComment } from "@/repositories/submission/types";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

let database: TestDatabase;
let env: AppEnv["Bindings"];
let sessions: Record<string, { authorization: string }>;
let moderation: AutoModerationMsg[];
let webhooks: WebhookMsg[];
let liveNotifications: Array<{ recipient: string; body: unknown }>;

const comment = {
  markerId: "marker-1",
  poiHash: "hash",
  poiType: "poi",
  content: "The entrance is on the east side.",
};

beforeEach(() => {
  database = createTestDatabase();
  sessions = {};
  for (const [uid, role] of [
    ["author", "n"],
    ["reader", "n"],
    ["other-reader", "n"],
    ["admin", "a"],
    ["root", "r"],
    ["reviewer", "p"],
    ["suspended", "s"],
  ]) {
    insertUser(database.sqlite, { uid, role });
    insertAuthUser(database.sqlite, { id: uid });
    sessions[uid] = insertSession(database.sqlite, { userId: uid }).headers;
  }
  moderation = [];
  webhooks = [];
  liveNotifications = [];
  // Only external Workers/Redis facilities are substituted. Authentication,
  // comment rules, repository writes and notification creation run normally.
  env = {
    ...testAuthConfig,
    DB: database.db,
    LOCK_UPLOAD_ENDPOINTS: "false",
    OEM_AUTH_RATE_LIMIT: { limit: async () => ({ success: true }) },
    OEM_MODERATION_Q: {
      send: async (message: AutoModerationMsg) => {
        moderation.push(message);
      },
    },
    OEM_WEBHOOK_Q: {
      send: async (message: WebhookMsg) => {
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
  database.close();
});

async function request(path: string, user: string | null = "author", body?: unknown) {
  const app = createApp();
  const pending: Promise<unknown>[] = [];
  const response = await app.request(
    `http://localhost/uploads/v1${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { ...((user && sessions[user]) || {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    { waitUntil: (work: Promise<unknown>) => pending.push(work) } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
  return response;
}

function post(path: string, user = "author", body: unknown = {}) {
  return request(path, user, body);
}

async function mine(user = "author") {
  const response = await request("/comments/mine?markerId=marker-1", user);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: UserSubmissionComment[] }).items;
}

function submission(id: string) {
  return database.sqlite.prepare("SELECT * FROM ugc_submissions WHERE id = ?").get(id)!;
}

function activeFlaggers(id: string) {
  return database.sqlite
    .prepare(
      "SELECT user_id FROM ugc_submission_flags WHERE submission_id = ? AND active = 1 ORDER BY user_id",
    )
    .all(id)
    .map((row) => row.user_id);
}

function persistedState() {
  return {
    comments: database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all(),
    flags: database.sqlite
      .prepare("SELECT * FROM ugc_submission_flags ORDER BY submission_id, user_id")
      .all(),
    notifications: database.sqlite.prepare("SELECT * FROM notifications ORDER BY id").all(),
    notificationMessages: database.sqlite
      .prepare("SELECT * FROM notification_messages ORDER BY id")
      .all(),
    reviews: database.sqlite.prepare("SELECT * FROM ugc_review_events ORDER BY id").all(),
  };
}

describe("comment submission and replies", () => {
  it("saves a new comment for its author and queues its pending version for moderation", async () => {
    const response = await post("/comments", "author", {
      ...comment,
      content: `  ${comment.content}  `,
    });
    expect(response.status).toBe(200);
    const { submission: created } = (await response.json()) as {
      submission: { id: string; snapshotId: string };
    };
    expect(created).toMatchObject({
      markerId: "marker-1",
      parentId: null,
      depth: 0,
      status: "pending_openai",
    });
    expect(submission(created.id)).toMatchObject({
      user_id: "author",
      poi_id: "marker-1",
      poi_hash: "hash",
      poi_type: "poi",
      kind: "comment",
      content: comment.content,
      status: "pending_openai",
      parent_id: null,
      comment_depth: 0,
      snapshot_id: created.snapshotId,
    });
    expect(await mine()).toEqual([
      expect.objectContaining({
        id: created.id,
        content: comment.content,
        status: "pending_openai",
      }),
    ]);
    expect(await mine("reader")).toEqual([]);
    expect(moderation).toEqual([
      expect.objectContaining({
        type: "moderation",
        submissionId: created.id,
        snapshotId: created.snapshotId,
        source: "upload",
      }),
    ]);
    expect(webhooks).toEqual([]);
    expect(liveNotifications).toEqual([]);
  });

  it.each(["active", "flagged", "remove_request"])(
    "accepts a nested reply to a parent with status %s without notifying its author before approval",
    async (status) => {
      insertSubmission(database.sqlite, { id: "root", userId: "author" });
      insertSubmission(database.sqlite, {
        id: "parent",
        userId: "reader",
        parentId: "root",
        depth: 1,
        status,
      });
      const response = await post("/comments", "author", { ...comment, parentId: "parent" });
      expect(response.status).toBe(200);
      const { submission: reply } = (await response.json()) as {
        submission: { id: string; snapshotId: string; parentId: string; depth: number };
      };
      expect(reply).toMatchObject({ parentId: "parent", depth: 2, status: "pending_openai" });
      expect(submission(reply.id)).toMatchObject({
        user_id: "author",
        parent_id: "parent",
        comment_depth: 2,
        content: comment.content,
        status: "pending_openai",
      });
      expect(moderation).toEqual([
        expect.objectContaining({ submissionId: reply.id, snapshotId: reply.snapshotId }),
      ]);
      expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
      expect(liveNotifications).toEqual([]);
    },
  );

  it.each([
    { name: "missing parent", parent: null, status: 404, code: "PARENT_COMMENT_NOT_FOUND" },
    {
      name: "an image",
      parent: { kind: "image" as const },
      status: 404,
      code: "PARENT_COMMENT_NOT_FOUND",
    },
    {
      name: "another marker",
      parent: { markerId: "marker-2" },
      status: 409,
      code: "PARENT_COMMENT_MISMATCH",
    },
    {
      name: "another POI hash",
      parent: { poiHash: "different" },
      status: 409,
      code: "PARENT_COMMENT_MISMATCH",
    },
    {
      name: "another POI type",
      parent: { poiType: "different" },
      status: 409,
      code: "PARENT_COMMENT_MISMATCH",
    },
    ...["pending_openai", "pending_audit", "stale"].map((status) => ({
      name: `a ${status} comment`,
      parent: { status },
      status: 409,
      code: "PARENT_COMMENT_NOT_VISIBLE",
    })),
  ])("rejects a reply to $name without saving or queuing it", async ({ parent, status, code }) => {
    if (parent) {
      insertSubmission(database.sqlite, { id: "parent", userId: "reader", ...parent });
    }
    const before = persistedState();
    const response = await post("/comments", "author", { ...comment, parentId: "parent" });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(persistedState()).toEqual(before);
    expect(moderation).toEqual([]);
    expect(webhooks).toEqual([]);
  });
});

describe("comment votes", () => {
  it("toggles matching votes, replaces opposite votes and keeps each reader's vote separate", async () => {
    insertSubmission(database.sqlite, { id: "target", userId: "author" });

    const steps = [
      { user: "reader", action: "upvote", previousVote: 0, vote: 1, score: 1 },
      { user: "reader", action: "upvote", previousVote: 1, vote: 0, score: 0 },
      { user: "reader", action: "downvote", previousVote: 0, vote: -1, score: -1 },
      { user: "reader", action: "upvote", previousVote: -1, vote: 1, score: 1 },
      { user: "other-reader", action: "downvote", previousVote: 0, vote: -1, score: 0 },
    ];
    for (const { user, action, previousVote, vote, score } of steps) {
      const response = await post(`/comments/target/${action}`, user);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, previousVote, vote, score });
    }

    expect(
      database.sqlite
        .prepare(
          "SELECT user_id, value, active FROM ugc_submission_votes WHERE submission_id = 'target' ORDER BY user_id",
        )
        .all(),
    ).toEqual([
      { user_id: "other-reader", value: -1, active: 1 },
      { user_id: "reader", value: 1, active: 1 },
    ]);
  });
});

describe("comment flags", () => {
  it("lets a reader flag a comment again after withdrawing their earlier flag", async () => {
    insertSubmission(database.sqlite, { id: "target", userId: "author" });
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
    expect(submission("target").status).toBe("flagged");
    expect(activeFlaggers("target")).toEqual(["reader"]);
    expect(webhooks.map((message) => message.event.type)).toEqual([
      "flag_created",
      "flag_removed",
      "flag_created",
    ]);
  });

  it("counts each reader once and restores the comment only after the last flag is withdrawn", async () => {
    insertSubmission(database.sqlite, { id: "target", userId: "author" });

    const flag = await post("/comments/target/flag", "reader");
    expect(flag.status).toBe(200);
    expect(await flag.json()).toEqual({ ok: true, created: true, status: "flagged", flagCount: 1 });
    expect(submission("target").status).toBe("flagged");
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
    expect(submission("target").status).toBe("flagged");

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
    expect(submission("target").status).toBe("active");
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
    insertSubmission(database.sqlite, { id: "target", userId: "author" });
    await post("/comments/target/flag", "reader");
    const before = persistedState();
    const response = await post(`/comments/target/${action}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    expect(persistedState()).toEqual(before);
    expect(webhooks).toHaveLength(1);
  });

  it.each(["pending_openai", "pending_audit", "remove_request", "stale"])(
    "does not accept or withdraw flags while a comment is %s",
    async (status) => {
      insertSubmission(database.sqlite, { id: "target", userId: "author", status });
      const before = persistedState();
      for (const action of ["flag", "unflag"]) {
        const response = await post(`/comments/target/${action}`, "reader");
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "INVALID_SUBMISSION_STATUS" });
      }
      expect(persistedState()).toEqual(before);
      expect(webhooks).toEqual([]);
    },
  );
});

describe("comment edits", () => {
  it("replaces a flagged comment with a pending revision, clears old flags and preserves an undo version", async () => {
    insertSubmission(database.sqlite, {
      id: "target",
      userId: "author",
      content: "Use the west entrance.",
    });
    await post("/comments/target/flag", "reader");
    await post("/comments/target/flag", "other-reader");
    const response = await post("/comments/target/edit", "author", { content: comment.content });
    expect(response.status).toBe(200);
    const { submission: edited } = (await response.json()) as {
      submission: { id: string; snapshotId: string; status: string };
    };
    expect(edited).toMatchObject({ id: "target", status: "pending_openai" });
    expect(edited.snapshotId).not.toBe("snapshot-target");
    expect(submission("target")).toMatchObject({
      user_id: "author",
      content: comment.content,
      status: "pending_openai",
      snapshot_id: edited.snapshotId,
      edit_original_content: "Use the west entrance.",
      edit_original_status: "flagged",
      edit_original_snapshot_id: "snapshot-target",
    });
    expect(activeFlaggers("target")).toEqual([]);
    expect(await mine()).toEqual([
      expect.objectContaining({
        id: "target",
        content: comment.content,
        status: "pending_openai",
        flagCount: 0,
      }),
    ]);
    const publicRead = await request("/comments/target?markerId=marker-1", null);
    expect(publicRead.status).toBe(404);
    expect(moderation).toEqual([
      expect.objectContaining({ submissionId: "target", snapshotId: edited.snapshotId }),
    ]);
    expect(webhooks).toHaveLength(2);
  });

  it.each(["admin", "root"])(
    "allows %s to correct another author's comment without changing its ownership",
    async (user) => {
      insertSubmission(database.sqlite, { id: "target", userId: "author" });
      const response = await post("/comments/target/edit", user, { content: comment.content });
      expect(response.status).toBe(200);
      expect(submission("target")).toMatchObject({
        user_id: "author",
        content: comment.content,
        status: "pending_openai",
        edit_original_content: "Content target",
      });
      expect(await mine(user)).toEqual([]);
      expect((await mine())[0]).toMatchObject({ id: "target", content: comment.content });
      expect(moderation).toEqual([expect.objectContaining({ submissionId: "target" })]);
    },
  );

  it.each(["reader", "reviewer"])(
    "rejects an edit by %s and preserves the original comment",
    async (user) => {
      insertSubmission(database.sqlite, { id: "target", userId: "author" });
      const before = persistedState();
      const response = await post("/comments/target/edit", user, { content: comment.content });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "COMMENT_EDIT_OWNER_ONLY" });
      expect(persistedState()).toEqual(before);
      expect(moderation).toEqual([]);
    },
  );

  it("keeps an unchanged comment's version, flags and visibility without another moderation job", async () => {
    insertSubmission(database.sqlite, { id: "target", userId: "author", content: comment.content });
    await post("/comments/target/flag", "reader");
    const before = persistedState();
    const response = await post("/comments/target/edit", "author", {
      content: `  ${comment.content}  `,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      submission: {
        id: "target",
        status: "flagged",
        snapshotId: "snapshot-target",
      },
    });
    expect(persistedState()).toEqual(before);
    expect(moderation).toEqual([]);
    expect(webhooks).toHaveLength(1);
  });

  it("rejects editing a withdrawn comment without changing it", async () => {
    insertSubmission(database.sqlite, { id: "target", userId: "author", status: "stale" });
    const before = persistedState();
    const response = await post("/comments/target/edit", "author", { content: comment.content });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INVALID_SUBMISSION_STATUS" });
    expect(persistedState()).toEqual(before);
    expect(moderation).toEqual([]);
  });
});

describe("comment recall", () => {
  it.each(["pending_openai", "pending_audit", "active", "flagged", "remove_request"])(
    "withdraws an unedited %s comment and delivers one resolution notification even if retried",
    async (status) => {
      insertSubmission(database.sqlite, {
        id: "target",
        userId: "author",
        status: ["flagged", "remove_request"].includes(status) ? "active" : status,
      });
      if (status === "flagged") {
        await post("/comments/target/flag", "reader");
      }
      if (status === "remove_request") {
        await post("/comments/target/remove-request");
      }
      const response = await post("/comments/target/recall");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, status: "stale" });
      expect(submission("target")).toMatchObject({ status: "stale", content: "Content target" });
      expect(await mine()).toEqual([]);
      expect((await request("/comments/target?markerId=marker-1", null)).status).toBe(404);
      expect(
        database.sqlite
          .prepare(
            "SELECT from_status, to_status, source FROM ugc_review_events WHERE submission_id = 'target'",
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
          submission_id: "target",
          message_count: 1,
        },
      ]);
      expect(liveNotifications).toEqual([
        {
          recipient: "author",
          body: expect.objectContaining({
            event: "notification.upserted",
            notification: expect.objectContaining({
              type: "system.remove_request.resolved",
              target: expect.objectContaining({ submissionId: "target", markerId: "marker-1" }),
            }),
            unread: { system: 1, community: 0, total: 1 },
          }),
        },
      ]);

      const beforeRetry = persistedState();
      const retry = await post("/comments/target/recall");
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ ok: true, status: "stale" });
      expect(persistedState()).toEqual(beforeRetry);
      expect(liveNotifications).toHaveLength(1);
      expect(moderation).toEqual([]);
    },
  );

  it.each([
    ["active", "active"],
    ["flagged", "active"],
    ["remove_request", "active"],
    ["pending_openai", "pending_openai"],
    ["pending_audit", "pending_audit"],
  ])(
    "undoes an edit from status %s and restores the comment as %s",
    async (originalStatus, restoredStatus) => {
      insertSubmission(database.sqlite, { id: "parent", userId: "reader" });
      insertSubmission(database.sqlite, {
        id: "target",
        userId: "author",
        parentId: "parent",
        depth: 1,
        status: ["flagged", "remove_request"].includes(originalStatus) ? "active" : originalStatus,
        content: "The entrance is on the west side.",
      });
      if (originalStatus === "flagged") {
        await post("/comments/target/flag", "reader");
      }
      if (originalStatus === "remove_request") {
        await post("/comments/target/remove-request");
      }
      const edit = await post("/comments/target/edit", "author", { content: comment.content });
      expect(edit.status).toBe(200);
      const editedSnapshot = submission("target").snapshot_id;
      const recall = await post("/comments/target/recall");
      expect(recall.status).toBe(200);
      expect(await recall.json()).toEqual({
        ok: true,
        editReverted: true,
        status: restoredStatus,
        content: "The entrance is on the west side.",
      });
      expect(submission("target")).toMatchObject({
        content: "The entrance is on the west side.",
        status: restoredStatus,
        snapshot_id: "snapshot-target",
        parent_id: "parent",
        comment_depth: 1,
        edit_original_content: null,
        edit_original_status: null,
        edit_original_snapshot_id: null,
      });
      expect((await mine())[0]).toMatchObject({
        id: "target",
        content: "The entrance is on the west side.",
        status: restoredStatus,
      });
      // Editing clears flags on the old wording. Undo restores that wording without
      // reviving those flags or the author's earlier removal request.
      expect(activeFlaggers("target")).toEqual([]);
      // An original version still awaiting AI review needs its own job after undo.
      expect(moderation.map((message) => message.snapshotId)).toEqual(
        originalStatus === "pending_openai"
          ? [editedSnapshot, "snapshot-target"]
          : [editedSnapshot],
      );
      expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
    },
  );
});

describe("comment removal requests", () => {
  it.each(["active", "flagged"])(
    "keeps a comment with status %s visible while its author's removal request awaits review",
    async (status) => {
      insertSubmission(database.sqlite, { id: "target", userId: "author" });
      if (status === "flagged") {
        await post("/comments/target/flag", "reader");
      }
      const flaggers = activeFlaggers("target");
      const response = await post("/comments/target/remove-request");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, status: "remove_request" });
      expect(submission("target")).toMatchObject({
        status: "remove_request",
        content: "Content target",
      });
      expect(activeFlaggers("target")).toEqual(flaggers);
      expect((await mine())[0]).toMatchObject({ id: "target", status: "remove_request" });
      const visible = await request("/comments/target?markerId=marker-1", null);
      expect(visible.status).toBe(200);
      expect(await visible.json()).toMatchObject({
        item: {
          targetId: "target",
          path: [
            expect.objectContaining({
              id: "target",
              content: "Content target",
              status: "remove_request",
            }),
          ],
        },
      });
      expect(webhooks.at(-1)).toMatchObject({
        event: {
          type: "remove_request_created",
          actor: { uid: "author" },
          submission: { id: "target" },
          previousStatus: status,
          nextStatus: "remove_request",
          source: "remove_request",
        },
      });
      expect(moderation).toEqual([]);

      const before = persistedState();
      const webhookCountBeforeRetry = webhooks.length;
      const retry = await post("/comments/target/remove-request");
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
      expect(persistedState()).toEqual(before);
      expect(webhooks).toHaveLength(webhookCountBeforeRetry);
    },
  );

  it.each(["pending_openai", "pending_audit", "stale"])(
    "rejects a removal request for a %s comment without changing data",
    async (status) => {
      insertSubmission(database.sqlite, { id: "target", userId: "author", status });
      const before = persistedState();
      const response = await post("/comments/target/remove-request");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
      expect(persistedState()).toEqual(before);
      expect(webhooks).toEqual([]);
    },
  );
});

describe("comment write permissions", () => {
  it.each([
    ["reader", "recall", "RECALL_OWNER_ONLY"],
    ["admin", "recall", "RECALL_OWNER_ONLY"],
    ["reader", "remove-request", "REMOVE_REQUEST_OWNER_ONLY"],
    ["admin", "remove-request", "REMOVE_REQUEST_OWNER_ONLY"],
  ])("prevents %s from using %s on another author's comment", async (user, action, code) => {
    insertSubmission(database.sqlite, { id: "target", userId: "author" });
    await post("/comments/target/flag", "reader");
    const before = persistedState();
    const response = await post(`/comments/target/${action}`, user);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    expect(persistedState()).toEqual(before);
    expect(webhooks).toHaveLength(1);
    expect(liveNotifications).toEqual([]);
  });

  it.each(["edit", "flag", "unflag", "recall", "remove-request"])(
    "does not apply comment %s to a missing submission or an image",
    async (action) => {
      insertSubmission(database.sqlite, { id: "image", kind: "image", userId: "author" });
      const before = persistedState();
      for (const id of ["missing", "image"]) {
        const response = await post(`/comments/${id}/${action}`, "author", {
          content: comment.content,
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
      }
      expect(persistedState()).toEqual(before);
      expect(moderation).toEqual([]);
      expect(webhooks).toEqual([]);
      expect(liveNotifications).toEqual([]);
    },
  );

  describe.each([
    {
      name: "an unauthenticated visitor",
      user: null,
      locked: false,
      status: 401,
      code: "SESSION_REQUIRED",
    },
    {
      name: "a suspended user",
      user: "suspended",
      locked: false,
      status: 403,
      code: "ACCESS_DENIED",
    },
    {
      name: "an author while uploads are locked",
      user: "author",
      locked: true,
      status: 503,
      code: "UPLOADS_TEMPORARILY_DISABLED",
    },
  ])("$name", ({ user, locked, status, code }) => {
    it.each([
      { action: "submit", name: "submit a comment" },
      { action: "edit", name: "edit a comment" },
      { action: "flag", name: "flag a comment" },
      { action: "unflag", name: "withdraw a flag" },
      { action: "recall", name: "recall a comment" },
      { action: "remove-request", name: "request comment removal" },
    ])("cannot $name or change its existing flags", async ({ action }) => {
      insertSubmission(database.sqlite, { id: "target", userId: "author" });
      await post("/comments/target/flag", "reader");
      if (locked) {
        env.LOCK_UPLOAD_ENDPOINTS = "true";
        vi.spyOn(console, "error").mockImplementation(() => {});
      }
      const before = persistedState();
      const path = action === "submit" ? "/comments" : `/comments/target/${action}`;
      const response = await request(path, user, comment);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(persistedState()).toEqual(before);
      expect(moderation).toEqual([]);
      expect(webhooks).toHaveLength(1);
      expect(liveNotifications).toEqual([]);
    });
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
