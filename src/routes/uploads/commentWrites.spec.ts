import { Hono, type ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes } from "./createRoutes";

const { publicReadCache, redis } = vi.hoisted(() => ({
  publicReadCache: {
    purgeMarker: vi.fn<(kind: string, markerId: string) => Promise<{ success: boolean }>>(),
  },
  redis: {
    zremrangebyscore: vi.fn<() => Promise<number>>(),
    zcard: vi.fn<() => Promise<number>>(),
    zadd: vi.fn<() => Promise<number>>(),
    expire: vi.fn<() => Promise<number>>(),
  },
}));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: publicReadCache },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {
      return redis;
    }
  },
}));

describe.each(["new comments", "comment edits"] as const)("%s content boundaries", (operation) => {
  let database: TestDatabase;
  const send = vi.fn<Queue["send"]>();
  let bindings: Bindings;
  let app: Hono<AppEnv>;
  let sessionHeaders: ReturnType<typeof insertSession>["headers"];

  beforeEach(() => {
    vi.resetAllMocks();
    redis.zremrangebyscore.mockResolvedValue(0);
    redis.zcard.mockResolvedValue(0);
    redis.zadd.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);
    publicReadCache.purgeMarker.mockResolvedValue({ success: true });
    database = createTestDatabase();
    insertUser(database.sqlite, { uid: "author" });
    insertAuthUser(database.sqlite, { id: "author" });
    sessionHeaders = insertSession(database.sqlite, { userId: "author" }).headers;
    send.mockResolvedValue({ metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } } });
    bindings = {
      ...testAuthConfig,
      DB: database.db,
      LOCK_UPLOAD_ENDPOINTS: "false",
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
      OEM_MODERATION_Q: { send } as unknown as Queue,
    } as Bindings;
    app = new Hono<AppEnv>();
    app.onError(onAppError);
    app.route("/uploads/v1", createRoutes());
  });

  afterEach(() => database.close());

  async function checkContent(content: string, accepted: boolean, storedContent = content) {
    // Each original input gets an independent edit target; rejected edits must retain its snapshot.
    const id = crypto.randomUUID();
    if (operation === "comment edits") {
      insertSubmission(database.sqlite, { id, userId: "author", content: "Original comment" });
    }
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all();
    const moderationCount = send.mock.calls.length;
    const pending: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    let response: Response;
    try {
      response = await app.request(
        `http://localhost/uploads/v1/comments${operation === "comment edits" ? `/${id}/edit` : ""}`,
        {
          method: "POST",
          headers: { ...sessionHeaders, "content-type": "application/json" },
          body: JSON.stringify(
            operation === "comment edits"
              ? { content }
              : {
                  markerId: "marker-1",
                  poiHash: "hash",
                  poiType: "poi",
                  content,
                },
          ),
        },
        bindings,
        executionCtx,
      );
    } finally {
      // Finish this request's cache invalidation before checking state or closing its database.
      await Promise.all(pending);
    }
    expect(response.status, content).toBe(accepted ? 200 : 422);
    if (!accepted) {
      expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all()).toEqual(
        before,
      );
      expect(send).toHaveBeenCalledTimes(moderationCount);
      return;
    }
    const payload = (await response.json()) as {
      ok: boolean;
      submission: { id: string; snapshotId: string; status: string };
    };
    expect(payload).toMatchObject({ ok: true, submission: { status: "pending_openai" } });
    expect(
      database.sqlite
        .prepare("SELECT content, snapshot_id, status FROM ugc_submissions WHERE id = ?")
        .get(payload.submission.id),
    ).toEqual({
      content: storedContent,
      snapshot_id: payload.submission.snapshotId,
      status: "pending_openai",
    });
    if (operation === "comment edits") {
      expect(payload.submission.id).toBe(id);
      expect(payload.submission.snapshotId).not.toBe(`snapshot-${id}`);
    }
    // Each accepted write queues moderation for exactly the snapshot that was persisted.
    expect(send).toHaveBeenCalledTimes(moderationCount + 1);
    expect(send).toHaveBeenLastCalledWith({
      type: "moderation",
      submissionId: payload.submission.id,
      snapshotId: payload.submission.snapshotId,
      source: "upload",
      queuedAt: expect.any(String),
    });
  }

  it("accepts 500 text units and rejects 501", async () => {
    await checkContent("中".repeat(500), true);
    await checkContent("中".repeat(501), false);
    await checkContent("😀".repeat(250), true);
    await checkContent("😀".repeat(250) + "a", false);
  });

  it("allows 250 rendered emojis even though their source exceeds 500 characters", async () => {
    const content = ":sns_001:".repeat(250);
    await checkContent(content, true);
    await checkContent(content + ":sns_038:", false);
  });

  it("preserves trimming and rejects blank or excessively long source", async () => {
    await checkContent("  hello  ", true, "hello");
    await checkContent(" \n\t ", false);
    await checkContent(":sns_001:".repeat(251), false);
  });
});
