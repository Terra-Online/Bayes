import { type ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";
import type { Bindings } from "@/types/app";

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
  let app: ReturnType<typeof createApp>;
  let sessionHeaders: ReturnType<typeof insertSession>["headers"];

  beforeEach(() => {
    vi.resetAllMocks();
    redis.zremrangebyscore.mockResolvedValue(0);
    redis.zcard.mockResolvedValue(0);
    redis.zadd.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);
    publicReadCache.purgeMarker.mockResolvedValue({ success: true });
    database = createTestDatabase();
    if (operation === "new comments") {
      importCurrentSubmissions(database);
    }
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
    app = createApp();
  });

  afterEach(() => database.close());

  async function checkContent(content: string, storedContent = content) {
    // Each source gets an independent edit target so its moderation snapshot is observable.
    const id = crypto.randomUUID();
    if (operation === "comment edits") {
      insertSubmission(database.sqlite, { id, userId: "author", content: "Original comment" });
    }
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
    expect(response.status, content).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      submission: { id: string; snapshotId: string; status: string };
    };
    expect(payload).toMatchObject({ ok: true, submission: { status: "pending_openai" } });
    expect(
      database.sqlite
        .prepare(
          operation === "new comments"
            ? "SELECT content, id AS snapshot_id, review_status AS status FROM ugc_snapshots WHERE submission_id = ?"
            : "SELECT content, snapshot_id, status FROM ugc_submissions WHERE id = ?",
        )
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

  it("persists maximum text and Unicode content and queues its stored snapshot", async () => {
    await checkContent("中".repeat(500));
    await checkContent("😀".repeat(250));
  });

  it("persists maximum rendered emoji source and queues its stored snapshot", async () => {
    const content = ":sns_001:".repeat(250);
    await checkContent(content);
  });

  it("stores trimmed content and queues the persisted moderation snapshot", async () => {
    await checkContent("  hello  ", "hello");
  });
});
