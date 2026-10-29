import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import {
  getDuplicateImageMarkerSummary,
  listDuplicateImageMarkers,
  listDuplicateMarkerImages,
} from "@/repositories/submission-duplicates";
import { listAllImageFilePaths } from "@/repositories/submission-review";
import { listVisibleImageCountsByMarker } from "@/repositories/submission/imageCoverage";
import { listActiveImagesByMarker } from "@/repositories/submission/listImages";
import { createImageLifecycleFixture } from "@/test/fixtures/imageLifecycle";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { insertSubmission } from "@/test/fixtures/submissions";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";

const fixtures: ReturnType<typeof createImageLifecycleFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
  }
});

function setup() {
  const fixture = createImageLifecycleFixture();
  fixtures.push(fixture);
  insertSubmission(fixture.database.sqlite, {
    id: "photo",
    userId: "author",
    kind: "image",
    filePath: "images/A.webp",
    snapshotId: "A",
  });
  importCurrentSubmissions(fixture.database);
  return fixture;
}

describe("snapshot image HTTP paths", () => {
  it("reads 100 markers with scoped viewer reactions without exceeding D1 parameter limits", async () => {
    const { database } = setup();
    const markerIds = Array.from({ length: 100 }, (_, index) => `point-${index}`);
    for (const [index, markerId] of markerIds.entries()) {
      insertImageSnapshot(database.sqlite, { id: `image-${index}`, userId: "author", markerId });
    }
    const images = await listActiveImagesByMarker(database.db, {
      markerIds,
      viewerUserId: "reader",
      assetBaseUrl: "https://assets",
      excludePathPrefix: "_test",
    });
    expect(images).toHaveLength(100);
    expect(new Set(images.map((image) => image.snapshotId)).size).toBe(100);
    expect(images.every((image) => image.upvoted === false && image.flagged === false)).toBe(true);
  });

  it("counts submissions once across retained versions and keeps historical files referenced", async () => {
    const { database } = setup();
    insertImageSnapshot(database.sqlite, { id: "second", userId: "reader" });
    insertImageSnapshot(database.sqlite, {
      id: "test",
      userId: "reader",
      filePath: "_test/test.webp",
    });
    database.sqlite
      .exec(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,file_path,review_status,creator_user_id)
      VALUES ('B','photo','image',2,'images/B.webp','pending_openai','author');
      UPDATE ugc_submissions SET revision=2 WHERE id='photo';`);
    const scope = { excludePathPrefix: "_test" };
    expect(await listVisibleImageCountsByMarker(database.db, scope)).toEqual([
      { markerId: "marker-1", imageCount: 2 },
    ]);
    expect(
      await getDuplicateImageMarkerSummary(database.db, { markerId: "marker-1", ...scope }),
    ).toEqual({ markerId: "marker-1", imageCount: 2 });
    const images = await listActiveImagesByMarker(database.db, {
      markerId: "marker-1",
      assetBaseUrl: "https://assets",
      ...scope,
    });
    expect(images).toHaveLength(2);
    expect(images.find((image) => image.id === "photo")).toMatchObject({
      snapshotId: "A",
      url: "https://assets/images/A.webp",
    });
    expect(
      await listDuplicateImageMarkers(database.db, { assetBaseUrl: "https://assets", ...scope }),
    ).toMatchObject({ total: 1, items: [{ imageCount: 2 }] });
    expect(
      await listDuplicateMarkerImages(database.db, {
        markerId: "marker-1",
        assetBaseUrl: "https://assets",
        ...scope,
      }),
    ).toMatchObject({ total: 2, items: expect.any(Array) });
    database.sqlite.exec("UPDATE ugc_snapshots SET review_status='rejected' WHERE id='B'");
    expect(await listVisibleImageCountsByMarker(database.db, scope)).toEqual([
      { markerId: "marker-1", imageCount: 1 },
    ]);
    expect(await listAllImageFilePaths(database.db)).toEqual([
      "_test/test.webp",
      "images/A.webp",
      "images/B.webp",
      "images/second.webp",
    ]);
  });

  it("rolls back identity when snapshot persistence fails, retaining the uploaded object", async () => {
    const { database, env, request, moderation } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue(null);
    env.UGC_BUCKET.put = put;
    database.sqlite.exec(`CREATE TRIGGER fail_image_snapshot BEFORE INSERT ON ugc_snapshots
      BEGIN SELECT RAISE(ABORT,'snapshot write unavailable'); END;`);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "image.webp", { type: "image/webp" }));
    form.set("markerId", "marker-1");
    form.set("poiHash", "hash");
    form.set("poiType", "poi");
    expect((await request("/images", "author", form)).status).toBe(500);
    expect(database.sqlite.prepare("SELECT id FROM ugc_submissions").all()).toEqual([
      { id: "photo" },
    ]);
    expect(database.sqlite.prepare("SELECT id FROM ugc_snapshots").all()).toEqual([{ id: "A" }]);
    expect(put).toHaveBeenCalledOnce();
    expect(moderation).toEqual([]);
  });

  it("authorizes conditional files before 304 and keeps hidden owner archive previews", async () => {
    const { database, env, request, sessions } = setup();
    const getObject = vi.fn().mockImplementation(async () => ({
      body: new Uint8Array([1]),
      httpEtag: '"image"',
      httpMetadata: {},
      writeHttpMetadata: () => {},
    }));
    env.UGC_BUCKET.get = getObject;
    const app = createApp();
    const conditional = () =>
      app.request(
        "http://localhost/uploads/v1/public-file/images/A.webp",
        { headers: { "if-none-match": '"image"' } },
        env,
      );
    expect((await conditional()).status).toBe(304);
    database.sqlite.exec("UPDATE ugc_submissions SET author_deleted_at='deleted' WHERE id='photo'");
    getObject.mockClear();
    expect((await conditional()).status).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
    expect((await request("/file/images/A.webp", "author")).status).toBe(200);
    expect((await request("/file/images/A.webp", "reader")).status).toBe(404);
    const preview = await app.request(
      "http://localhost/me/v1/contributions/photo/preview",
      { headers: sessions.author },
      env,
    );
    expect(preview.status).toBe(200);
    getObject.mockClear();
    const stranger = await app.request(
      "http://localhost/me/v1/contributions/photo/preview",
      { headers: sessions.reader },
      env,
    );
    expect(stranger.status).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("creates an image snapshot and delivers its exact identity after commit", async () => {
    const { database, request, moderation, env } = setup();
    env.UGC_BUCKET.put = vi.fn().mockResolvedValue(null);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "image.webp", { type: "image/webp" }));
    form.set("markerId", "marker-1");
    form.set("poiHash", "hash");
    form.set("poiType", "poi");
    const response = await request("/images", "author", form);
    expect(response.status).toBe(200);
    const { submission } = (await response.json()) as {
      submission: { id: string; snapshotId: string; filePath: string };
    };
    expect(
      database.sqlite.prepare("SELECT revision FROM ugc_submissions WHERE id=?").get(submission.id),
    ).toEqual({ revision: 1 });
    expect(
      database.sqlite
        .prepare(
          "SELECT id, file_path, review_status, moderation_queued_at FROM ugc_snapshots WHERE submission_id=?",
        )
        .get(submission.id),
    ).toEqual({
      id: submission.snapshotId,
      file_path: submission.filePath,
      review_status: "pending_openai",
      moderation_queued_at: expect.any(String),
    });
    expect(moderation).toEqual([
      {
        type: "moderation",
        submissionId: submission.id,
        snapshotId: submission.snapshotId,
        source: "upload",
        queuedAt: expect.any(String),
      },
    ]);
  });

  it("keeps public A and private pending B file and snapshot identities together", async () => {
    const { database, env, request } = setup();
    database.sqlite
      .exec(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,file_path,review_status,creator_user_id)
      VALUES ('B','photo','image',2,'images/B.webp','pending_openai','author');
      UPDATE ugc_submissions SET revision=2 WHERE id='photo';`);
    const publicRead = await request("/images/photo?markerId=marker-1", null);
    expect(publicRead.status).toBe(200);
    expect(await publicRead.json()).toMatchObject({
      item: { snapshotId: "A", url: expect.stringContaining("images/A.webp"), status: "active" },
    });
    const mine = await request("/images/mine?markerId=marker-1");
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({
      items: [
        {
          snapshotId: "B",
          url: expect.stringContaining("/file/images/B.webp"),
          status: "pending_openai",
        },
      ],
    });
    const app = createApp();
    // Unauthorized conditional requests must fail before any R2 read or 304.
    const denied = await app.request(
      "http://localhost/uploads/v1/public-file/images/B.webp",
      { headers: { "if-none-match": '"image"' } },
      env,
    );
    expect(denied.status).toBe(404);
    database.sqlite.exec("UPDATE ugc_snapshots SET review_status='approved' WHERE id='B'");
    const current = await request("/images/photo?markerId=marker-1", null);
    expect(await current.json()).toMatchObject({
      item: { snapshotId: "B", url: expect.stringContaining("images/B.webp") },
    });
    const getObject = vi
      .fn()
      .mockRejectedValue(new Error("Unauthorized historical file must not reach storage"));
    env.UGC_BUCKET.get = getObject;
    const historical = await app.request(
      "http://localhost/uploads/v1/public-file/images/A.webp",
      { headers: { "if-none-match": '"image"' } },
      env,
    );
    expect(historical.status).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
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
