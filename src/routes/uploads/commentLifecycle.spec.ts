import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import type { UserSubmissionComment } from "@/repositories/submission/types";
import type {
  OemModerationQueueMessage,
  OemWebhookQueueMessage,
} from "@/services/moderation/messages";
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
  database.close();
});

async function request(path: string, user: string | null = "author", body?: unknown) {
  const app = createRoutes();
  app.onError(onAppError);
  const pending: Promise<unknown>[] = [];
  const response = await app.request(
    `http://localhost${path}`,
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
