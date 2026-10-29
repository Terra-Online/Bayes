import type { SQLOutputValue } from "node:sqlite";

import { createApp } from "@/app";
import type { AutoModerationMsg, WebhookMsg } from "@/queues/types/messages";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { AppEnv } from "@/types/app";

import { insertAuthUser, insertSession } from "./auth";
import { insertUser } from "./users";

export interface PersistedImageState {
  submissions: Record<string, SQLOutputValue>[];
  votes: Record<string, SQLOutputValue>[];
  flags: Record<string, SQLOutputValue>[];
  notifications: Record<string, SQLOutputValue>[];
  messages: Record<string, SQLOutputValue>[];
  reviews: Record<string, SQLOutputValue>[];
}

export interface ImageLifecycleFixture {
  database: TestDatabase;
  env: AppEnv["Bindings"];
  sessions: Record<string, { authorization: string }>;
  moderation: AutoModerationMsg[];
  webhooks: WebhookMsg[];
  liveNotifications: Array<{ recipient: string; body: unknown }>;
  request: (path: string, user?: string | null, body?: FormData | object) => Promise<Response>;
  submission: (id: string) => Record<string, SQLOutputValue>;
  persistedState: () => PersistedImageState;
}

export function createImageLifecycleFixture(): ImageLifecycleFixture {
  const database = createTestDatabase();
  const sessions: Record<string, { authorization: string }> = {};
  for (const [uid, role] of [
    ["author", "n"],
    ["reader", "n"],
    ["other-reader", "n"],
    ["admin", "a"],
    ["reviewer", "p"],
    ["root", "r"],
    ["suspended", "s"],
  ]) {
    insertUser(database.sqlite, { uid, role });
    insertAuthUser(database.sqlite, { id: uid });
    sessions[uid] = insertSession(database.sqlite, { userId: uid }).headers;
  }
  const moderation: AutoModerationMsg[] = [];
  const webhooks: WebhookMsg[] = [];
  const liveNotifications: Array<{ recipient: string; body: unknown }> = [];
  const mocks = createMockBindings({ DB: database.db });
  const env = {
    ...mocks.bindings,
    LOCK_UPLOAD_ENDPOINTS: "false",
    UGC_UPLOAD_TEST_PREFIX: "",
    UGC_ASSET_BASE_URL: "https://assets.example.test",
    OEM_PUBLIC_RATE_LIMIT: { limit: async () => ({ success: true }) },
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

  async function request(path: string, user: string | null = "author", body?: FormData | object) {
    const app = createApp();
    const pending: Promise<unknown>[] = [];
    const multipart = body instanceof FormData;
    const response = await app.request(
      `http://localhost/uploads/v1${path}`,
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

  function submission(id: string) {
    return database.sqlite.prepare("SELECT * FROM ugc_submissions WHERE id = ?").get(id)!;
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
      reviews: database.sqlite
        .prepare("SELECT * FROM ugc_snapshots_review_audit ORDER BY rowid")
        .all(),
    };
  }
  return {
    database,
    env,
    sessions,
    moderation,
    webhooks,
    liveNotifications,
    request,
    submission,
    persistedState,
  };
}
