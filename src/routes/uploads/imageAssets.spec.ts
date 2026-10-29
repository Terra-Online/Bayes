import { getRandom } from "@cloudflare/containers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import type { oem_imgTrans } from "@/services/ugc/submission/imageTranscoderContainer";
import {
  createImageLifecycleFixture,
  type ImageLifecycleFixture,
} from "@/test/fixtures/imageLifecycle";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";

let database: ImageLifecycleFixture["database"];
let env: ImageLifecycleFixture["env"];
let moderation: ImageLifecycleFixture["moderation"];
let webhooks: ImageLifecycleFixture["webhooks"];
let request: ImageLifecycleFixture["request"];
let submission: ImageLifecycleFixture["submission"];
let persistedState: ImageLifecycleFixture["persistedState"];
let sessions: ImageLifecycleFixture["sessions"];
type StoredImage = { bytes: Uint8Array; options: R2PutOptions };
let storage: Map<string, StoredImage>;
const transformedImage = new Uint8Array([82, 73, 70, 70, 4, 5, 6]);
const transform = vi.fn();

beforeEach(() => {
  ({ database, env, sessions, moderation, webhooks, request, submission, persistedState } =
    createImageLifecycleFixture());
  importCurrentSubmissions(database);
  submission = (id) =>
    database.sqlite
      .prepare(`SELECT s.*, r.id AS snapshot_id, r.content, r.file_path, r.mime_type, r.size_bytes, r.review_status AS status
    FROM ugc_submissions s JOIN ugc_snapshots r ON r.submission_id=s.id AND r.revision=s.revision WHERE s.id=?`)
      .get(id)!;
  persistedState = () => ({
    submissions: database.sqlite.prepare("SELECT * FROM ugc_submissions").all(),
    votes: database.sqlite.prepare("SELECT * FROM ugc_submission_upvotes").all(),
    flags: database.sqlite.prepare("SELECT * FROM ugc_submission_flags").all(),
    notifications: database.sqlite.prepare("SELECT * FROM notifications").all(),
    messages: database.sqlite.prepare("SELECT * FROM notification_messages").all(),
    reviews: database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all(),
  });
  storage = new Map();
  transform.mockReset().mockImplementation(
    async () =>
      new Response(transformedImage, {
        headers: { "content-type": "image/webp", "X-Converted-To-Webp": "true" },
      }),
  );
  vi.mocked(getRandom).mockResolvedValue({
    fetch: transform,
  } as unknown as DurableObjectStub<oem_imgTrans>);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  env.UGC_BUCKET = {
    put: async (key: string, body: ArrayBuffer, options: R2PutOptions) => {
      storage.set(key, { bytes: new Uint8Array(body), options });
    },
    get: async (key: string) => {
      const image = storage.get(key);
      return image
        ? {
            body: image.bytes,
            httpEtag: '"test-image"',
            httpMetadata: image.options.httpMetadata,
            writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/webp"),
          }
        : null;
    },
  } as unknown as R2Bucket;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  database.close();
});

function upload(
  file = new File([new Uint8Array([137, 80, 78, 71])], "entrance.png", { type: "image/png" }),
) {
  const form = new FormData();
  form.set("file", file);
  form.set("markerId", "marker-1");
  form.set("poiHash", "hash");
  form.set("poiType", "poi");
  form.set("content", "East entrance");
  return form;
}

describe("stored image delivery", () => {
  it.each([
    { mimeType: "image/jpeg", contentType: "image/jpeg" },
    { mimeType: null, contentType: "application/octet-stream" },
  ])(
    "serves legacy file metadata safely through mounted public and private paths: $contentType",
    async ({ mimeType, contentType }) => {
      const filePath = "images/old photo.jpg";
      insertImageSnapshot(database.sqlite, {
        id: "legacy-image",
        userId: "author",
        kind: "image",
        filePath,
        mimeType,
      });
      const before = persistedState();
      const app = createApp();
      const read = (path: string, headers?: Record<string, string>) =>
        app.request(
          `http://localhost/uploads/v1/${path}/${encodeURIComponent(filePath)}`,
          { headers },
          env,
        );
      for (const [path, headers] of [
        ["public-file", undefined],
        ["file", sessions.author],
      ] as const) {
        const missing = await read(path, headers);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({ code: "IMAGE_NOT_FOUND" });
      }
      storage.set(filePath, { bytes: transformedImage, options: {} });
      for (const [path, headers] of [
        ["public-file", undefined],
        ["file", sessions.author],
      ] as const) {
        const response = await read(path, headers);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(contentType);
        expect(response.headers.get("etag")).toBe('"test-image"');
        expect(response.headers.get("cache-control")).toMatch(
          path === "public-file" ? /^public, max-age=\d+, immutable$/ : /^private, max-age=\d+$/,
        );
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(transformedImage);
      }
      expect(persistedState()).toEqual(before);
      expect(moderation).toEqual([]);
    },
  );

  it("checks every matching file owner and preserves reviewers' access to stale images", async () => {
    const sharedPath = "images/shared.webp";
    const stalePath = "images/stale.webp";
    insertImageSnapshot(database.sqlite, {
      id: "shared-author",
      userId: "author",
      kind: "image",
      filePath: sharedPath,
      reviewStatus: "pending_audit",
    });
    insertImageSnapshot(database.sqlite, {
      id: "shared-reader",
      userId: "reader",
      kind: "image",
      filePath: sharedPath,
    });
    insertImageSnapshot(database.sqlite, {
      id: "stale",
      userId: "author",
      kind: "image",
      filePath: stalePath,
      reviewStatus: "unknown",
    });
    for (const path of [sharedPath, stalePath]) {
      storage.set(path, { bytes: transformedImage, options: {} });
    }
    for (const owner of ["author", "reader"]) {
      const response = await request(`/file/${sharedPath}`, owner);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(transformedImage);
    }
    expect((await request(`/file/${sharedPath}`, "other-reader")).status).toBe(404);
    expect((await request(`/file/${stalePath}`, "author")).status).toBe(200);
    expect((await request(`/public-file/${stalePath}`, null)).status).toBe(404);
    for (const reviewer of ["admin", "reviewer", "root"]) {
      const response = await request(`/file/${stalePath}`, reviewer);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(transformedImage);
    }
  });

  it.each(["public-file", "file"])(
    "rejects unsafe and malformed encoded %s paths before object storage is read",
    async (path) => {
      const getObject = vi
        .fn<R2Bucket["get"]>()
        .mockRejectedValue(new Error("Unexpected storage access"));
      env.UGC_BUCKET.get = getObject;
      const app = createApp();
      for (const key of [
        "%2Fprivate.webp",
        "%2E%2E%2Fprivate.webp",
        "images%5Cprivate.webp",
        "%ZZ",
      ]) {
        const response = await app.request(
          `http://localhost/uploads/v1/${path}/${key}`,
          { headers: sessions.author },
          env,
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      }
      expect(getObject).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual([]);
    },
  );
});

describe("image submission", () => {
  it("does not create a pending submission or moderation job when object storage fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storeImage = env.UGC_BUCKET.put;
    env.UGC_BUCKET.put = vi
      .fn<R2Bucket["put"]>()
      .mockRejectedValue(new Error("storage unavailable"));
    const response = await request("/images", "author", upload());
    expect(response.status).toBe(500);
    expect(storage.size).toBe(0);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual([]);
    expect(moderation).toEqual([]);
    env.UGC_BUCKET.put = storeImage;
    const retry = await request("/images", "author", upload());
    expect(retry.status).toBe(200);
    const payload = (await retry.json()) as { submission: { id: string; filePath: string } };
    expect(storage.size).toBe(1);
    expect(storage.has(payload.submission.filePath)).toBe(true);
    expect(
      database.sqlite
        .prepare("SELECT submission_id AS id, review_status AS status FROM ugc_snapshots")
        .all(),
    ).toEqual([{ id: payload.submission.id, status: "pending_openai" }]);
    expect(moderation).toEqual([expect.objectContaining({ submissionId: payload.submission.id })]);
  });

  it.each([
    {
      name: "image processing rejects the source",
      upstreamStatus: 422,
      status: 422,
      code: "IMAGE_PROCESSING_FAILED",
    },
    {
      name: "the image service is unavailable",
      upstreamStatus: 500,
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    },
    {
      name: "processing makes the image too large",
      upstreamStatus: 200,
      status: 422,
      code: "UPLOAD_SIZE_INVALID",
    },
  ])(
    "leaves no stored image or pending submission when $name",
    async ({ upstreamStatus, status, code }) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      env.MAX_UPLOAD_BYTES = "6";
      transform.mockImplementation(
        async () =>
          new Response(transformedImage, {
            status: upstreamStatus,
            headers: { "content-type": "image/webp" },
          }),
      );
      const response = await request("/images", "author", upload());
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(storage.size).toBe(0);
      expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual([]);
      expect(moderation).toEqual([]);
    },
  );

  it.each(["image/webp", "image/avif"])(
    "preserves an already compressed %s upload and warns about another image at the same marker",
    async (mime) => {
      insertImageSnapshot(database.sqlite, { id: "existing", userId: "reader", kind: "image" });
      const bytes = new Uint8Array([1, 2, 3]);
      const response = await request(
        "/images",
        "author",
        upload(new File([bytes], "entrance", { type: mime })),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { submission: { id: string; filePath: string } };
      expect(payload).toMatchObject({
        duplicatePoi: {
          markerId: "marker-1",
          imageCount: 2,
          dashboardPath: "/ugc-review?duplicateMarker=marker-1",
        },
      });
      expect(submission(payload.submission.id)).toMatchObject({
        mime_type: mime,
        size_bytes: 3,
        status: "pending_openai",
      });
      expect(storage.get(payload.submission.filePath)).toMatchObject({
        bytes,
        options: { customMetadata: { sourceMimeType: mime, convertedToWebp: "false" } },
      });
      expect(moderation).toEqual([
        expect.objectContaining({ submissionId: payload.submission.id }),
      ]);
    },
  );

  it("stores the processed image as a private pending submission and queues its moderation version", async () => {
    const response = await request("/images", "author", upload());
    expect(response.status).toBe(200);
    const { submission: created, duplicatePoi } = (await response.json()) as {
      submission: { id: string; snapshotId: string; filePath: string };
      duplicatePoi: unknown;
    };
    expect(duplicatePoi).toBeNull();
    expect(submission(created.id)).toMatchObject({
      kind: "image",
      user_id: "author",
      poi_id: "marker-1",
      poi_hash: "hash",
      poi_type: "poi",
      content: "East entrance",
      status: "pending_openai",
      file_path: created.filePath,
      snapshot_id: created.snapshotId,
      mime_type: "image/webp",
      size_bytes: 7,
    });
    expect(storage.get(created.filePath)).toEqual({
      bytes: transformedImage,
      options: {
        httpMetadata: {
          contentType: "image/webp",
          cacheControl: expect.stringMatching(/^public, max-age=\d+, immutable$/),
        },
        customMetadata: { sourceMimeType: "image/png", convertedToWebp: "true" },
      },
    });
    expect(moderation).toEqual([
      expect.objectContaining({
        type: "moderation",
        submissionId: created.id,
        snapshotId: created.snapshotId,
        source: "upload",
      }),
    ]);
    const mine = await request("/images/mine?markerId=marker-1");
    expect(await mine.json()).toMatchObject({
      items: [expect.objectContaining({ id: created.id, status: "pending_openai" })],
    });
    expect((await request(`/images/${created.id}?markerId=marker-1`, null)).status).toBe(404);
    expect((await request(`/public-file/${created.filePath}`, null)).status).toBe(404);
    const privateFile = await request(`/file/${created.filePath}`);
    expect(privateFile.status).toBe(200);
    expect(new Uint8Array(await privateFile.arrayBuffer())).toEqual(transformedImage);
    expect((await request(`/file/${created.filePath}`, "reader")).status).toBe(404);
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
