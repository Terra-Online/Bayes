import type { SQLOutputValue } from "node:sqlite";

import { onAppError } from "@/middleware/error-handler";
import { createRoutes } from "@/routes/moderation/createRoutes";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, testAuthConfig, type SessionHeaders } from "@/test/fixtures/auth";
import {
  insertSubmission,
  type SeededSubmission,
  type SubmissionFixture,
} from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { Bindings, Role } from "@/types/app";

type ModerationSubmissionFixture = Omit<SubmissionFixture, "userId"> & { userId?: string };
type ModerationRow = Record<string, SQLOutputValue>;

interface ModerationRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

interface ModerationMessages {
  moderation: unknown[];
  translation: unknown[];
  webhook: unknown[];
  live: Array<{ recipient: string; envelope: unknown }>;
}

export interface ModerationTestFixture {
  database: TestDatabase;
  env: Bindings;
  messages: ModerationMessages;
  createReviewerSession: (role?: Role, uid?: string) => SessionHeaders;
  submission: (input: ModerationSubmissionFixture) => SeededSubmission;
  request: (path: string, options?: ModerationRequestOptions) => Promise<Response>;
  storedSubmission: (id: string) => ModerationRow | undefined;
  authorPoints: () => SQLOutputValue;
  reviewAudits: () => ModerationRow[];
  storedSnapshot: (id: string) => ModerationRow | undefined;
  notificationMessages: () => ModerationRow[];
}

export function createModerationTestFixture(): ModerationTestFixture {
  const database = createTestDatabase();
  const messages: ModerationMessages = {
    moderation: [],
    translation: [],
    webhook: [],
    live: [],
  };
  insertUser(database.sqlite, { uid: "author", uid_number: 101, points: 20 });
  const env = {
    ...testAuthConfig,
    DB: database.db,
    LOCK_MODERATION_ENDPOINTS: "false",
    UGC_UPLOAD_TEST_PREFIX: "",
    UGC_ASSET_BASE_URL: "https://assets.example.test",
    ENABLE_COMMENT_TRANSLATION_PREWARM: "true",
    OEM_AUTH_RATE_LIMIT: { limit: async () => ({ success: true }) },
    OEM_MODERATION_Q: {
      send: async (message: unknown) => {
        messages.moderation.push(message);
      },
    },
    OEM_TRANSLATION_Q: {
      send: async (message: unknown) => {
        messages.translation.push(message);
      },
    },
    OEM_WEBHOOK_Q: {
      send: async (message: unknown) => {
        messages.webhook.push(message);
      },
    },
    OEM_NOTIFICATION_DO: {
      idFromName: (name: string) => name,
      get: (recipient: string) => ({
        fetch: async (_url: string, init: RequestInit) => {
          messages.live.push({ recipient, envelope: JSON.parse(String(init.body)) });
          return new Response(null, { status: 204 });
        },
      }),
    },
  } as unknown as Bindings;

  function createReviewerSession(
    role: Role = "p",
    uid: string = crypto.randomUUID(),
  ): SessionHeaders {
    // Unique users keep the production auth and local rate-limit caches independent.
    const userCount = Number(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()!.count,
    );
    return insertAuthenticatedUser(database.sqlite, {
      uid,
      uid_number: 1000 + userCount,
      role,
    }).headers;
  }

  function submission(input: ModerationSubmissionFixture): SeededSubmission {
    return insertSubmission(database.sqlite, { userId: "author", ...input });
  }

  async function request(path: string, options: ModerationRequestOptions = {}): Promise<Response> {
    const app = createRoutes();
    app.onError(onAppError);
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      `https://api.example.test${path}`,
      {
        method: options.method ?? "GET",
        headers: { "content-type": "application/json", ...options.headers },
        body:
          options.rawBody ??
          (options.body === undefined ? undefined : JSON.stringify(options.body)),
      },
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
        passThroughOnException() {},
      } as ExecutionContext,
    );
    // Complete waitUntil work before asserting queue delivery and live notifications.
    await Promise.all(pending);
    return response;
  }

  function storedSubmission(id: string): ModerationRow | undefined {
    return database.sqlite.prepare("SELECT * FROM ugc_submissions WHERE id = ?").get(id);
  }

  function authorPoints(): SQLOutputValue {
    return database.sqlite.prepare("SELECT points FROM users WHERE uid = 'author'").get()!.points;
  }

  function storedSnapshot(id: string): ModerationRow | undefined {
    return database.sqlite
      .prepare(`SELECT f.* FROM ugc_snapshots f JOIN ugc_submissions s
      ON s.id=f.submission_id AND s.revision=f.revision WHERE s.id=?`)
      .get(id);
  }
  function reviewAudits(): ModerationRow[] {
    return database.sqlite
      .prepare(`SELECT s.submission_id, a.from_status, a.to_status, a.source
      FROM ugc_snapshots_review_audit a JOIN ugc_snapshots s ON s.id=a.snapshot_id ORDER BY a.rowid`)
      .all();
  }

  function notificationMessages(): ModerationRow[] {
    return database.sqlite
      .prepare(`SELECT n.recipient_user_id, n.type, m.submission_id
      FROM notifications n JOIN notification_messages m ON m.notification_id = n.id
      ORDER BY n.recipient_user_id, m.submission_id`)
      .all();
  }

  return {
    database,
    env,
    messages,
    createReviewerSession,
    submission,
    request,
    storedSubmission,
    authorPoints,
    reviewAudits,
    storedSnapshot,
    notificationMessages,
  };
}
