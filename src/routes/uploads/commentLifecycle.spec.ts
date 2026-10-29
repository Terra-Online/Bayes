import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import type { AutoModerationMsg, WebhookMsg } from "@/queues/types/messages";
import type { UserSubmissionComment } from "@/repositories/submission/types";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
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

// Creation, replies and votes use the explicit snapshot-schema HTTP suite in commentCreationVotes.spec.ts.

// Version-bound reports are covered in reportAndImageVoteLifecycle.spec.ts.

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
