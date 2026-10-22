import { getRandom } from "@cloudflare/containers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { createMockBindings, createMockR2Object, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser } from "@/test/fixtures/auth";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes } from "./createRoutes";

vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));
// The rate-limit middleware runs normally; only its external Redis client is replaced.
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

describe("image submission through HTTP", () => {
  let mocks: MockBindings;
  let app: Hono<AppEnv>;
  let database: TestDatabase;
  let env: Bindings;
  let sessionHeaders: HeadersInit;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    database = createTestDatabase();
    mocks = createMockBindings({ DB: database.db });
    vi.mocked(getRandom).mockResolvedValue(mocks.imageTranscoder);
    const uploader = insertAuthenticatedUser(database.sqlite, { uid: "u", role: "n" });
    sessionHeaders = uploader.headers;
    env = {
      ...mocks.bindings,
      LOCK_UPLOAD_ENDPOINTS: "false",
    };
    app = new Hono<AppEnv>();
    app.onError(onAppError);
    app.route("/uploads/v1", createRoutes());
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  function request(signal?: AbortSignal) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "test.png", { type: "image/png" }));
    form.set("markerId", "42");
    form.set("poiHash", "hash");
    form.set("poiType", "poi");
    return app.request(
      new Request("http://localhost/uploads/v1/images", {
        method: "POST",
        body: form,
        headers: sessionHeaders,
        signal,
      }),
      undefined,
      env,
    );
  }

  function expectNoWrites() {
    expect(database.sqlite.prepare("SELECT id FROM ugc_submissions").all()).toEqual([]);
    expect(mocks.ugcBucket.put).not.toHaveBeenCalled();
    expect(mocks.moderationQueue.send).not.toHaveBeenCalled();
  }

  it("persists one pending image and queues its moderation after a successful retry", async () => {
    mocks.ugcBucket.put.mockImplementation(async (key) => createMockR2Object({ key, size: 2 }));
    mocks.moderationQueue.send.mockResolvedValue({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
    });
    const conversionRequests: Array<{
      url: string;
      method: string;
      headers: Headers;
      body: ArrayBuffer;
    }> = [];
    mocks.imageTranscoder.fetch.mockImplementation(async (input) => {
      const request = new Request(input);
      // Capture each body before the external service could consume it.
      conversionRequests.push({
        url: request.url,
        method: request.method,
        headers: new Headers(request.headers),
        body: await request.clone().arrayBuffer(),
      });
      if (conversionRequests.length === 1) {
        throw new Error("The container just disconnected");
      }
      return new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/webp" },
      });
    });

    const response = await request();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      submission: {
        id: string;
        markerId: string;
        status: string;
        filePath: string;
        snapshotId: string;
      };
      duplicatePoi: unknown;
    };
    expect(payload).toMatchObject({
      ok: true,
      submission: { markerId: "42", status: "pending_openai" },
      duplicatePoi: null,
    });
    expect(
      database.sqlite
        .prepare(`SELECT id, user_id, poi_id, kind, status, file_path,
      snapshot_id, mime_type, size_bytes, moderation_queued_at FROM ugc_submissions`)
        .all(),
    ).toEqual([
      {
        id: payload.submission.id,
        user_id: "u",
        poi_id: "42",
        kind: "image",
        status: "pending_openai",
        file_path: payload.submission.filePath,
        snapshot_id: payload.submission.snapshotId,
        mime_type: "image/webp",
        size_bytes: 2,
        moderation_queued_at: expect.any(String),
      },
    ]);
    // Recover from the first disconnect with a retry, then stop once conversion succeeds.
    expect(conversionRequests).toHaveLength(2);
    // Each attempt must send the full original image using the transcoder protocol.
    for (const conversionRequest of conversionRequests) {
      expect(new URL(conversionRequest.url).pathname).toBe("/prepare");
      expect(conversionRequest.method).toBe("POST");
      expect(conversionRequest.headers.get("content-type")).toBe("image/png");
      expect(conversionRequest.headers.get("x-source-mime")).toBe("image/png");
      expect(conversionRequest.headers.get("x-source-size-bytes")).toBe("3");
      expect(new Uint8Array(conversionRequest.body)).toEqual(new Uint8Array([1, 2, 3]));
    }
    // Retrying preparation must still store just one image for this submission.
    expect(mocks.ugcBucket.put).toHaveBeenCalledOnce();
    expect(mocks.ugcBucket.put).toHaveBeenCalledWith(
      payload.submission.filePath,
      new Uint8Array([4, 5]).buffer,
      expect.objectContaining({
        httpMetadata: expect.objectContaining({ contentType: "image/webp" }),
      }),
    );
    // The same submission must produce one moderation job, without duplicates from the retry.
    expect(mocks.moderationQueue.send).toHaveBeenCalledOnce();
    expect(mocks.moderationQueue.send).toHaveBeenCalledWith({
      type: "moderation",
      submissionId: payload.submission.id,
      snapshotId: payload.submission.snapshotId,
      source: "upload",
      queuedAt: expect.any(String),
    });
  });

  it.each([
    [422, 422, "IMAGE_PROCESSING_FAILED"],
    [429, 503, "DEPENDENCY_OVERLOADED"],
    [500, 503, "DEPENDENCY_UNAVAILABLE"],
  ])("leaves no business writes after upstream HTTP %s", async (upstreamStatus, status, code) => {
    mocks.imageTranscoder.fetch.mockResolvedValue(
      new Response("private container diagnostic", { status: upstreamStatus }),
    );
    const response = await request();
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe(status === 503 ? "5" : null);
    expect(await response.json()).toMatchObject({ code });
    expectNoWrites();
  });

  it("leaves no business writes after cancellation during preparation", async () => {
    const controller = new AbortController();
    mocks.imageTranscoder.fetch.mockImplementation(async () => {
      controller.abort();
      return new Response(new Uint8Array([4]), { headers: { "content-type": "image/png" } });
    });
    await request(controller.signal);
    // Cancellation during the first conversion must prevent further attempts.
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledOnce();
    expectNoWrites();
  });
});
