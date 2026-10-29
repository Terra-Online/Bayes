import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import type { AutoModerationMsg, WebhookMsg } from "@/queues/types/messages";
import type { UserSubmissionComment } from "@/repositories/submission/types";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertSubmission } from "@/test/fixtures/submissions";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: async () => ({ success: true }) } },
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

// Creation, replies and votes use the explicit snapshot-schema HTTP suite in commentCreationVotes.spec.ts.

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
  beforeEach(() => importCurrentSubmissions(database));

  it("appends pending content while keeping flagged public content and its reports", async () => {
    insertCommentSnapshot(database.sqlite, {
      id: "target",
      userId: "author",
      content: "Use the west entrance.",
    });
    database.sqlite.exec(
      "INSERT INTO ugc_submission_flags(submission_id,user_id,active) VALUES ('target','reader',1),('target','other-reader',1)",
    );
    const response = await post("/comments/target/edit", "author", {
      content: comment.content,
      parentSnapshotId: "snapshot-target",
    });
    expect(response.status).toBe(200);
    const { submission: edited } = (await response.json()) as {
      submission: { snapshotId: string };
    };
    expect(submission("target")).toMatchObject({ user_id: "author", revision: 2 });
    expect(activeFlaggers("target")).toEqual(["other-reader", "reader"]);
    expect(await mine()).toEqual([
      expect.objectContaining({
        id: "target",
        snapshotId: edited.snapshotId,
        content: comment.content,
        status: "pending_openai",
        flagCount: 2,
        editUndoAvailable: false,
      }),
    ]);
    const publicRead = await request("/comments/target?markerId=marker-1", null);
    expect(publicRead.status).toBe(200);
    expect(await publicRead.json()).toMatchObject({
      item: {
        path: [
          { snapshotId: "snapshot-target", content: "Use the west entrance.", status: "flagged" },
        ],
      },
    });
    expect(moderation).toEqual([
      expect.objectContaining({ submissionId: "target", snapshotId: edited.snapshotId }),
    ]);
    expect(webhooks).toEqual([]);
  });

  it.each(["admin", "root"])(
    "allows %s to correct a comment with stable ownership and actual creator",
    async (user) => {
      insertCommentSnapshot(database.sqlite, { id: "target", userId: "author" });
      const response = await post("/comments/target/edit", user, {
        content: comment.content,
        parentSnapshotId: "snapshot-target",
      });
      expect(response.status).toBe(200);
      expect(submission("target")).toMatchObject({ user_id: "author", revision: 2 });
      expect(
        database.sqlite
          .prepare("SELECT content,creator_user_id FROM ugc_snapshots WHERE revision=2")
          .get(),
      ).toEqual({ content: comment.content, creator_user_id: user });
      expect(await mine(user)).toEqual([]);
      expect((await mine())[0]).toMatchObject({ id: "target", content: comment.content });
      expect(moderation).toEqual([expect.objectContaining({ submissionId: "target" })]);
    },
  );

  it.each(["reader", "reviewer"])(
    "rejects an edit by %s without allocating a version",
    async (user) => {
      insertCommentSnapshot(database.sqlite, { id: "target", userId: "author" });
      const response = await post("/comments/target/edit", user, {
        content: comment.content,
        parentSnapshotId: "snapshot-target",
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "COMMENT_EDIT_OWNER_ONLY" });
      expect(submission("target").revision).toBe(1);
      expect(moderation).toEqual([]);
    },
  );

  it("keeps unchanged flagged content and visibility without another moderation job", async () => {
    insertCommentSnapshot(database.sqlite, {
      id: "target",
      userId: "author",
      content: comment.content,
    });
    database.sqlite.exec(
      "INSERT INTO ugc_submission_flags(submission_id,user_id,active) VALUES ('target','reader',1)",
    );
    const response = await post("/comments/target/edit", "author", {
      content: `  ${comment.content}  `,
      parentSnapshotId: "snapshot-target",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      submission: { id: "target", status: "flagged", snapshotId: "snapshot-target" },
    });
    expect(submission("target").revision).toBe(1);
    expect(activeFlaggers("target")).toEqual(["reader"]);
    expect(moderation).toEqual([]);
    expect(webhooks).toEqual([]);
  });

  it("rejects editing a deleted comment without changing it", async () => {
    insertCommentSnapshot(database.sqlite, { id: "target", userId: "author" });
    database.sqlite.exec("UPDATE ugc_submissions SET author_deleted_at='gone' WHERE id='target'");
    const response = await post("/comments/target/edit", "author", {
      content: comment.content,
      parentSnapshotId: "snapshot-target",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "COMMENT_EDIT_CONFLICT" });
    expect(submission("target").revision).toBe(1);
    expect(moderation).toEqual([]);
  });
});

// Author recall/removal/undo requirements were retired by lifecycle spec section 4.
// New-schema DELETE, retained history, ownership and retired-404 cases live in authorDeletion.spec.ts.
