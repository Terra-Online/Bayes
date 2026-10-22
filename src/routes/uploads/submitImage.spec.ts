import { getRandom } from "@cloudflare/containers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { requestIdMiddleware } from "@/middleware/request-id";
import { createMockBindings, createMockR2Object, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type SessionHeaders } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes } from "./createRoutes";

vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));
// The middleware executes normally against a fresh external Redis client per case.
const { redisClient } = vi.hoisted(() => ({
  redisClient: { current: {} as UploadRedis },
}));
interface UploadRedis {
  zremrangebyscore: (key: string, min: number, max: number) => Promise<number>;
  zcard: (key: string) => Promise<number>;
  zadd: (key: string, entry: { score: number; member: string }) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
}
vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {
      return redisClient.current;
    }
  },
}));

describe("image submission through HTTP", () => {
  let mocks: MockBindings;
  let app: Hono<AppEnv>;
  let database: TestDatabase;
  let env: Bindings;
  let sessionHeaders: SessionHeaders;

  beforeEach(() => {
    vi.mocked(getRandom).mockReset();
    redisClient.current = {
      zremrangebyscore: vi.fn<UploadRedis["zremrangebyscore"]>().mockResolvedValue(0),
      zcard: vi.fn<UploadRedis["zcard"]>().mockResolvedValue(0),
      zadd: vi.fn<UploadRedis["zadd"]>().mockResolvedValue(1),
      expire: vi.fn<UploadRedis["expire"]>().mockResolvedValue(1),
    };
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
    app.use(requestIdMiddleware);
    app.route("/uploads/v1", createRoutes());
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  function request(
    signal?: AbortSignal,
    mimeType = "image/png",
    options: {
      fileName?: string;
      headers?: Record<string, string>;
      fields?: Record<string, string>;
    } = {},
  ) {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([1, 2, 3])], options.fileName ?? "test.png", { type: mimeType }),
    );
    form.set("markerId", "42");
    form.set("poiHash", "hash");
    form.set("poiType", "poi");
    for (const [key, value] of Object.entries(options.fields ?? {})) {
      form.set(key, value);
    }
    return app.request(
      new Request("http://localhost/uploads/v1/images", {
        method: "POST",
        body: form,
        headers: { ...sessionHeaders, "x-request-id": "upload-request", ...options.headers },
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

  it("accepts a camera image with generic MIME using its filename and stores the processed format", async () => {
    mocks.ugcBucket.put.mockImplementation(async (key) => createMockR2Object({ key, size: 2 }));
    mocks.moderationQueue.send.mockResolvedValue({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
    });
    mocks.imageTranscoder.fetch.mockResolvedValue(
      new Response(new Uint8Array([4, 5]), { headers: { "content-type": "image/webp" } }),
    );
    const response = await request(undefined, "application/octet-stream", {
      fileName: "Camera.HEIC",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { submission: { id: string; filePath: string } };
    const conversion = new Request(mocks.imageTranscoder.fetch.mock.calls[0]![0]);
    expect(conversion.headers.get("content-type")).toBe("image/heic");
    expect(conversion.headers.get("x-source-mime")).toBe("image/heic");
    expect(new Uint8Array(await conversion.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.ugcBucket.put).toHaveBeenCalledWith(
      payload.submission.filePath,
      new Uint8Array([4, 5]).buffer,
      expect.objectContaining({
        customMetadata: expect.objectContaining({ sourceMimeType: "image/heic" }),
      }),
    );
    expect(
      database.sqlite
        .prepare("SELECT mime_type, status FROM ugc_submissions WHERE id = ?")
        .get(payload.submission.id),
    ).toEqual({ mime_type: "image/webp", status: "pending_openai" });
    expect(mocks.moderationQueue.send).toHaveBeenCalledOnce();
  });

  it("keeps beta uploads and private lists in the test namespace while local demo reads select production", async () => {
    env.UGC_UPLOAD_TEST_PREFIX = "prod";
    insertSubmission(database.sqlite, {
      id: "production",
      userId: "u",
      kind: "image",
      markerId: "42",
      filePath: "prod/original.webp",
    });
    mocks.ugcBucket.put.mockImplementation(async (key) => createMockR2Object({ key, size: 3 }));
    mocks.moderationQueue.send.mockResolvedValue({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
    });
    const betaHeaders = {
      origin: "invalid-origin",
      referer: "https://beta.opendfieldmap.org/marker/42",
    };
    const response = await request(undefined, "image/webp", { headers: betaHeaders });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      submission: { id: string; filePath: string };
      duplicatePoi: unknown;
    };
    expect(payload.submission.filePath).toMatch(/^_test\/poi\/poi\/hash\//);
    expect(payload.duplicatePoi).toBeNull();
    expect(
      database.sqlite
        .prepare("SELECT file_path, status FROM ugc_submissions WHERE id = ?")
        .get(payload.submission.id),
    ).toEqual({ file_path: payload.submission.filePath, status: "pending_openai" });
    const read = (query = "") =>
      app.request(
        `http://localhost/uploads/v1/images/mine?markerId=42${query}`,
        { headers: { ...sessionHeaders, ...betaHeaders } },
        env,
      );
    const testRead = await read();
    expect(testRead.status).toBe(200);
    expect(await testRead.json()).toMatchObject({ items: [{ id: payload.submission.id }] });
    const demoRead = await read("&demoLocal=1");
    expect(demoRead.status).toBe(200);
    expect(await demoRead.json()).toMatchObject({ items: [{ id: "production" }] });
    expect(mocks.moderationQueue.send).toHaveBeenCalledOnce();
    expect(getRandom).not.toHaveBeenCalled();
  });

  it("keeps uploads disabled until the deployment explicitly enables them", async () => {
    env.LOCK_UPLOAD_ENDPOINTS = undefined;
    const response = await request(undefined, "image/webp");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "UPLOADS_TEMPORARILY_DISABLED" });
    expectNoWrites();
    expect(getRandom).not.toHaveBeenCalled();
  });

  it("keeps untrusted POI labels inside the generated object path", async () => {
    mocks.ugcBucket.put.mockImplementation(async (key) => createMockR2Object({ key, size: 3 }));
    mocks.moderationQueue.send.mockResolvedValue({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
    });
    const response = await request(undefined, "image/webp", {
      fields: { poiHash: "../", poiType: "矿石" },
    });
    expect(response.status).toBe(200);
    const { submission } = (await response.json()) as {
      submission: { id: string; snapshotId: string; filePath: string };
    };
    expect(submission.filePath).toBe(`_test/poi/unknown/unknown/${submission.snapshotId}.webp`);
    expect(
      database.sqlite
        .prepare("SELECT poi_hash, poi_type, file_path, status FROM ugc_submissions WHERE id = ?")
        .get(submission.id),
    ).toEqual({
      poi_hash: "unknown",
      poi_type: "unknown",
      file_path: submission.filePath,
      status: "pending_openai",
    });
    expect(mocks.ugcBucket.put).toHaveBeenCalledOnce();
    expect(mocks.moderationQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: submission.id, snapshotId: submission.snapshotId }),
    );
  });

  it("rejects missing marker identity before processing or storing the image", async () => {
    const response = await request(undefined, "image/webp", { fields: { markerId: "" } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expectNoWrites();
    expect(getRandom).not.toHaveBeenCalled();
  });

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
    [400, 422, "IMAGE_PROCESSING_FAILED"],
    [413, 422, "IMAGE_PROCESSING_FAILED"],
    [415, 422, "IMAGE_PROCESSING_FAILED"],
    [422, 422, "IMAGE_PROCESSING_FAILED"],
    [429, 503, "DEPENDENCY_OVERLOADED"],
    [500, 503, "DEPENDENCY_UNAVAILABLE"],
    [503, 503, "DEPENDENCY_UNAVAILABLE"],
  ])("leaves no business writes after upstream HTTP %s", async (upstreamStatus, status, code) => {
    mocks.imageTranscoder.fetch.mockResolvedValue(
      new Response("private container diagnostic", { status: upstreamStatus }),
    );
    const response = await request();
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe(status === 503 ? "5" : null);
    expect(await response.json()).toMatchObject({ code });
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      "image preparation failed",
      expect.objectContaining({
        attempt: 1,
        stage: "container_response",
        requestId: "upload-request",
      }),
    );
    expectNoWrites();
  });

  it.each(["image/webp", "image/avif"])(
    "passes through %s without a container",
    async (mimeType) => {
      mocks.ugcBucket.put.mockImplementation(async (key) => createMockR2Object({ key, size: 3 }));
      mocks.moderationQueue.send.mockResolvedValue({
        metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
      });
      const response = await request(undefined, mimeType);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { submission: { id: string; filePath: string } };
      expect(mocks.ugcBucket.put).toHaveBeenCalledWith(
        payload.submission.filePath,
        new Uint8Array([1, 2, 3]).buffer,
        expect.objectContaining({
          httpMetadata: expect.objectContaining({ contentType: mimeType }),
          customMetadata: expect.objectContaining({ convertedToWebp: "false" }),
        }),
      );
      expect(
        database.sqlite
          .prepare("SELECT mime_type, size_bytes FROM ugc_submissions WHERE id = ?")
          .get(payload.submission.id),
      ).toEqual({ mime_type: mimeType, size_bytes: 3 });
      expect(getRandom).not.toHaveBeenCalled();
    },
  );

  it("limits disconnect retries to two attempts", async () => {
    mocks.imageTranscoder.fetch.mockRejectedValue(new Error("The container just disconnected"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledTimes(2);
    expectNoWrites();
  });

  it("never retries a flagged overload even if its message mentions disconnect", async () => {
    mocks.imageTranscoder.fetch.mockRejectedValue(
      Object.assign(new Error("The container just disconnected"), { overloaded: true }),
    );
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "DEPENDENCY_OVERLOADED" });
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledOnce();
    expectNoWrites();
  });

  it("classifies an explicit container capacity limit as overload", async () => {
    mocks.imageTranscoder.fetch.mockResolvedValue(
      new Response("Container capacity exhausted", { status: 503 }),
    );
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "DEPENDENCY_OVERLOADED" });
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledOnce();
    expectNoWrites();
  });

  it.each(["text/html", "", "image/not-real"])(
    "rejects malformed success MIME %j",
    async (mimeType) => {
      mocks.imageTranscoder.fetch.mockResolvedValue(
        new Response("body", { headers: { "content-type": mimeType } }),
      );
      const response = await request();
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: "IMAGE_PROCESSING_BAD_RESPONSE" });
      expect(mocks.imageTranscoder.fetch).toHaveBeenCalledOnce();
      expectNoWrites();
    },
  );

  it("rejects empty successful images", async () => {
    mocks.imageTranscoder.fetch.mockResolvedValue(
      new Response(null, { headers: { "content-type": "image/png" } }),
    );
    const response = await request();
    expect(response.status).toBe(502);
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
