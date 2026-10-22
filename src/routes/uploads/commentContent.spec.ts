import { Hono, type ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { commentEditSchema, commentSubmissionSchema } from "@/routes/schema/uploads";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type SessionHeaders } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import type { AppEnv } from "@/types/app";

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
  let mocks: MockBindings;
  let app: Hono<AppEnv>;
  let sessionHeaders: SessionHeaders;

  beforeEach(() => {
    vi.resetAllMocks();
    redis.zremrangebyscore.mockResolvedValue(0);
    redis.zcard.mockResolvedValue(0);
    redis.zadd.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);
    publicReadCache.purgeMarker.mockResolvedValue({ success: true });
    database = createTestDatabase();
    sessionHeaders = insertAuthenticatedUser(database.sqlite, { uid: "author" }).headers;
    mocks = createMockBindings({ DB: database.db });
    mocks.moderationQueue.send.mockResolvedValue({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
    });
    app = new Hono<AppEnv>();
    app.onError(onAppError);
    app.route("/uploads/v1", createRoutes());
  });

  afterEach(() => database.close());

  // Migration 0012 still rejects persisted comment source >= 200 characters.
  // Keep the existing schema acceptance guarantees until that production mismatch
  // is resolved; HTTP rejection and trimming below use the unmodified database.
  function expectAcceptedSource(content: string) {
    const parsed =
      operation === "comment edits"
        ? commentEditSchema.safeParse({ content })
        : commentSubmissionSchema.safeParse({
            markerId: "marker-1",
            poiHash: "hash",
            poiType: "poi",
            content,
          });
    expect(parsed.success, content).toBe(true);
    if (!parsed.success) {
      throw new Error("Comment source was rejected");
    }
    expect(parsed.data.content).toBe(content);
  }

  async function checkContent(content: string, accepted: boolean, storedContent = content) {
    // Each original input gets an independent edit target; rejected edits must retain its snapshot.
    const id = crypto.randomUUID();
    if (operation === "comment edits") {
      insertSubmission(database.sqlite, { id, userId: "author", content: "Original comment" });
    }
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all();
    const moderationCount = mocks.moderationQueue.send.mock.calls.length;
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
        { ...mocks.bindings, LOCK_UPLOAD_ENDPOINTS: "false" },
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
      expect(mocks.moderationQueue.send).toHaveBeenCalledTimes(moderationCount);
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
    expect(mocks.moderationQueue.send).toHaveBeenCalledTimes(moderationCount + 1);
    expect(mocks.moderationQueue.send).toHaveBeenLastCalledWith({
      type: "moderation",
      submissionId: payload.submission.id,
      snapshotId: payload.submission.snapshotId,
      source: "upload",
      queuedAt: expect.any(String),
    });
  }

  it("accepts 500 text units and rejects 501", async () => {
    expectAcceptedSource("中".repeat(500));
    await checkContent("中".repeat(501), false);
    expectAcceptedSource("😀".repeat(250));
    await checkContent("😀".repeat(250) + "a", false);
  });

  it("allows 250 rendered emojis even though their source exceeds 500 characters", async () => {
    const content = ":sns_001:".repeat(250);
    expectAcceptedSource(content);
    await checkContent(content + ":sns_038:", false);
  });

  it("enforces the same boundary for mixed text, formats, code, links and escapes", async () => {
    // Fixed source-rule lengths: valid emoji tokens cost two UTF-16 units;
    // formatting, code, escapes and link syntax retain their respective source overhead.
    for (const [suffix, length] of [
      [":sns_038:", 2],
      ["**:sns_001:**", 6],
      ["`:sns_001:`", 11],
      ["\\:sns_001:", 10],
      ["[:sns_001:](https://example.com)", 25],
      ["[label](https://example.com/:sns_001:)", 38],
      [":sns_000:", 9],
      [":sns_039:", 9],
    ] as const) {
      const atLimit = "a".repeat(500 - length) + suffix;
      expectAcceptedSource(atLimit);
      await checkContent(atLimit + "a", false);
    }
  });

  it("preserves trimming and rejects blank or excessively long source", async () => {
    await checkContent("  hello  ", true, "hello");
    await checkContent(" \n\t ", false);
    await checkContent(":sns_001:".repeat(251), false);
  });
});
