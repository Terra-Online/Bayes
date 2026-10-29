import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi, type Mocked } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { onAppError } from "@/middleware/error-handler";
import { appendCommentVersion } from "@/repositories/submission/appendCommentVersion";
import { reviewSnapshot, getReviewTarget } from "@/repositories/submission/reviewSnapshot";
import type { ContributionItem } from "@/services/me/contract/contributions";
import { createMockBindings, createMockR2Object, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, type SeededSession } from "@/test/fixtures/auth";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { seedImageReadScenario } from "@/test/fixtures/imageReadScenario";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let mocks: MockBindings;
let app: Hono<AppEnv>;
let sessions: Map<string, SeededSession>;
beforeEach(() => {
  database = createTestDatabase();
  seedImageReadScenario(database.sqlite);
  sessions = new Map();
  for (const uid of ["author", "other"]) {
    const user = insertAuthUser(database.sqlite, { id: uid });
    sessions.set(uid, insertSession(database.sqlite, { userId: user.id }));
  }

  // Historical notes/events cannot become new audit evidence after import.
  database.sqlite
    .exec(`UPDATE ugc_submissions SET moderation_note='OpenAI moderation passed: clean' WHERE id='photo';
    INSERT INTO ugc_review_events (submission_id,snapshot_id,from_status,to_status,source,created_at)
      VALUES ('photo','current','pending_audit','active','manual_moderation','2026-09-04');`);
  importCurrentSubmissions(database);
  mocks = createMockBindings({ DB: database.db });
  mocks.ugcBucket.get.mockImplementation(async () => {
    const response = new Response(new Uint8Array([82, 73, 70, 70]));
    return {
      ...previewMetadata(),
      body: response.body!,
      get bodyUsed() {
        return response.bodyUsed;
      },
      arrayBuffer: () => response.arrayBuffer(),
      bytes: () => response.bytes(),
      text: () => response.text(),
      json: () => response.json(),
      blob: () => response.blob(),
    } satisfies R2ObjectBody;
  });
  app = new Hono<AppEnv>();
  app.onError(onAppError);
  app.route("/me/v1", createRoutes());
});
afterEach(() => {
  database.close();
  vi.restoreAllMocks();
});

function requestPreview(id: string, uid?: string, headers?: HeadersInit) {
  return requestPath(`/contributions/${id}/preview`, uid, headers);
}
async function requestPath(path: string, uid?: string, headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  if (uid) {
    requestHeaders.set("authorization", sessions.get(uid)!.headers.authorization);
  }
  return runWithAuthRequest(() =>
    app.request(`http://localhost/me/v1${path}`, { headers: requestHeaders }, mocks.bindings),
  );
}

it("serves an owner's image bytes with private cache headers", async () => {
  const response = await requestPreview("photo", "author");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/webp");
  expect(response.headers.get("Cache-Control")).toMatch(/^private, max-age=\d+, must-revalidate$/);
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Authorization");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
  expect(mocks.ugcBucket.get).toHaveBeenCalledWith("images/photo.webp", {
    onlyIf: expect.any(Headers),
  });
});

it.each([
  ["image/jpeg", "image/jpeg"],
  [null, "application/octet-stream"],
])("serves legacy preview MIME %s when object metadata is absent", async (mimeType, expected) => {
  insertImageSnapshot(database.sqlite, { id: "mime-preview", userId: "author", mimeType });
  const response = new Response(new Uint8Array([1, 2, 3]));
  mocks.ugcBucket.get.mockResolvedValueOnce({
    ...createMockR2Object({ key: "images/photo.webp", size: 3 }),
    httpMetadata: {},
    writeHttpMetadata: () => {},
    body: response.body!,
    bodyUsed: false,
    arrayBuffer: () => response.arrayBuffer(),
    bytes: () => response.bytes(),
    text: () => response.text(),
    json: () => response.json(),
    blob: () => response.blob(),
  });
  // Warming the list must not affect the freshly authorized preview MIME fallback.
  expect((await requestPath("/contributions", "author")).status).toBe(200);
  const preview = await requestPreview("mime-preview", "author");
  expect(preview.status).toBe(200);
  expect(preview.headers.get("content-type")).toBe(expected);
  expect(preview.headers.get("cache-control")).toMatch(/^private, max-age=\d+, must-revalidate$/);
  expect(new Uint8Array(await preview.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect((await requestPreview("photo", "other")).status).toBe(404);
});

it("keeps historical previews available to their owner only", async () => {
  database.sqlite.exec(
    "UPDATE ugc_submissions SET author_deleted_at = '2026-10-01' WHERE id = 'photo'",
  );
  expect((await requestPreview("photo", "author")).status).toBe(200);
  mocks.ugcBucket.get.mockClear();
  expect((await requestPreview("photo", "other")).status).toBe(404);
  expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
});

it("rejects unauthenticated requests and missing image objects", async () => {
  expect((await requestPreview("photo")).status).toBe(401);
  expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
  mocks.ugcBucket.get.mockResolvedValue(null);
  expect((await requestPreview("photo", "author")).status).toBe(404);
});

it("revalidates an owner's cached preview without sending image bytes", async () => {
  // Vitest models only R2.get's last overload; conditional reads can return
  // metadata without a body. Keep the actual R2Object shape for the 304 path.
  vi.mocked(mocks.ugcBucket.get, { partial: true }).mockResolvedValueOnce(previewMetadata());
  const response = await requestPreview("photo", "author", { "If-None-Match": '"test"' });
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(response.headers.get("etag")).toBe('"test"');
  const condition = mocks.ugcBucket.get.mock.calls[0][1]?.onlyIf;
  expect((condition as Headers).get("If-None-Match")).toBe('"test"');
  mocks.ugcBucket.get.mockClear();
  expect((await requestPreview("photo", "other", { "If-None-Match": '"test"' })).status).toBe(404);
  expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
});

it("caches completed overview counts and pages separately by owner and filter", async () => {
  const { entered, release } = pauseFirstOverviewQuery();
  const prepare = vi.mocked(database.db.prepare);
  const businessQueries = () => prepare.mock.calls.filter(([sql]) => /ugc_submissions/.test(sql));
  const first = requestPath("/overview", "author");
  await entered;
  let secondResponse: Response | undefined;
  const second = requestPath("/overview", "author").then((response) => {
    secondResponse = response;
    return response;
  });
  try {
    // Authentication may finish at different times. Hold the first business read
    // so the second must complete against a still-cold cache.
    await vi.waitFor(() => expect(secondResponse?.status).toBe(200));
  } finally {
    release();
  }
  const responses = await Promise.all([first, second]);
  expect(businessQueries()).toHaveLength(2);
  await requestPath("/overview", "author");
  expect(businessQueries()).toHaveLength(2);
  type Summary = {
    contributions: { imageCount: number; recent?: unknown };
    loginMethods?: unknown;
  };
  const data = (await responses[0].json()) as Summary;
  expect(data.contributions.imageCount).toBe(3);
  expect(data.contributions.recent).toBeUndefined();
  expect(data.loginMethods).toBeUndefined();
  expect(responses[0].headers.get("Cache-Control")).toMatch(
    /^private, max-age=\d+, must-revalidate$/,
  );
  const other = (await (await requestPath("/overview", "other")).json()) as Summary;
  expect(other.contributions.imageCount).toBe(0);
  prepare.mockClear();
  const image = await requestPath("/contributions?kind=image&limit=1", "author");
  expect(((await image.json()) as { items: unknown[] }).items).toHaveLength(1);
  await requestPath("/contributions?kind=image&limit=1", "author");
  expect(businessQueries()).toHaveLength(1);
  await requestPath("/contributions?kind=comment&limit=1", "author");
  await requestPath("/contributions?kind=image&limit=1", "other");
  expect(businessQueries()).toHaveLength(3);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15_001);
  await requestPath("/contributions?kind=image&limit=1", "author");
  expect(businessQueries()).toHaveLength(4);
});

it("keeps concurrent overview queries independent when the first query fails", async () => {
  const { entered, fail } = pauseFirstOverviewQuery();
  const first = requestPath("/overview", "author");
  await entered;
  let secondResponse: Response | undefined;
  const second = requestPath("/overview", "author").then((response) => {
    secondResponse = response;
  });
  try {
    // Prove completion while the first business query is still blocked.
    await vi.waitFor(() => expect(secondResponse?.status).toBe(200));
  } finally {
    fail(new Error("first request failed"));
  }
  await second;
  const failed = await first;
  expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  expect((await requestPath("/overview", "author")).status).toBe(200);
});

interface OverviewQueryGate {
  entered: Promise<void>;
  release: () => void;
  fail: (error: Error) => void;
}

/** Suspend only the first overview query; authentication and later reads stay real. */
function pauseFirstOverviewQuery(): OverviewQueryGate {
  let enter!: () => void;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const prepare = database.db.prepare.bind(database.db);
  let blocked = false;
  vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!blocked && /AS image_count/.test(sql)) {
      blocked = true;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        bound.first = async <Result>(column?: string) => {
          enter();
          await pending;
          return column === undefined ? first<Result>() : first<Result>(column);
        };
        return bound;
      };
    }
    return statement;
  });
  return { entered, release, fail };
}

function previewMetadata(): Mocked<R2Object> {
  const object = createMockR2Object({
    key: "images/photo.webp",
    size: 4,
    httpMetadata: { contentType: "image/webp" },
  });
  object.writeHttpMetadata.mockImplementation((headers) =>
    headers.set("Content-Type", "image/webp"),
  );
  return { ...object, httpEtag: '"test"' };
}

async function listOwnerContributions(): Promise<{ items: ContributionItem[] }> {
  const response = await requestPath("/contributions?limit=20", "author");
  expect(response.status).toBe(200);
  return response.json();
}

it("retains complete owner content and truthful imported history without parsing old notes", async () => {
  const content = "**a long comment** ".repeat(30);
  insertCommentSnapshot(database.sqlite, {
    id: "long",
    userId: "author",
    content,
    reviewStatus: "unknown",
  });
  const { items } = await listOwnerContributions();
  expect(items.find((item) => item.id === "photo")).toMatchObject({
    snapshotId: "current",
    revision: 1,
    reviewStatus: "approved",
    previewUrl: "/me/v1/contributions/photo/preview",
    review: {
      events: [],
      manual: false,
      published: true,
      times: { ai: null, manual: null, public: null },
    },
  });
  expect(items.find((item) => item.id === "long")).toMatchObject({
    content,
    previewUrl: null,
    reviewStatus: "unknown",
    visibility: "unavailable",
    review: { events: [], published: false, times: { archived: null } },
  });
});

it("shows the owner's pending frontier instead of the public previous version", async () => {
  insertCommentSnapshot(database.sqlite, { id: "edited", userId: "author", content: "Public A" });
  const result = await appendCommentVersion(database.db, {
    submissionId: "edited",
    parentSnapshotId: "snapshot-edited",
    snapshotId: "B",
    actorId: "author",
    content: "Private B",
  });
  expect(result.outcome).toBe("appended");
  expect((await listOwnerContributions()).items.find((item) => item.id === "edited")).toMatchObject(
    {
      content: "Private B",
      snapshotId: "B",
      revision: 2,
      status: "pending_openai",
      reviewStatus: "pending_openai",
      visibility: "private",
      review: { events: [] },
    },
  );
  const overview = await requestPath("/overview", "author");
  expect(await overview.json()).toMatchObject({
    contributions: { imageCount: 3, commentCount: 1, pendingCount: 1 },
  });
  const other = await requestPath("/contributions", "other");
  expect(await other.json()).toMatchObject({ items: [] });
});

it.each(["rejected", "unknown", "author_deleted", "admin_disabled"] as const)(
  "keeps %s content in the owner's archive and denies cross-owner conditional preview",
  async (state) => {
    insertUser(database.sqlite, { uid: "admin", role: "a" });
    insertImageSnapshot(database.sqlite, {
      id: "hidden",
      userId: "author",
      reviewStatus: state === "rejected" || state === "unknown" ? state : "pending_audit",
    });
    if (state === "author_deleted") {
      database.sqlite.exec(
        "UPDATE ugc_submissions SET author_deleted_at='2026-10-01' WHERE id='hidden'",
      );
    }
    if (state === "admin_disabled") {
      database.sqlite.exec(
        "UPDATE ugc_submissions SET admin_deleted_at='2026-10-01', admin_deleted_by='admin' WHERE id='hidden'",
      );
    }
    expect(
      (await listOwnerContributions()).items.find((item) => item.id === "hidden"),
    ).toMatchObject({
      snapshotId: "snapshot-hidden",
      status: "stale",
      visibility: "unavailable",
      previewUrl: "/me/v1/contributions/hidden/preview",
    });
    expect((await requestPreview("hidden", "author")).status).toBe(200);
    mocks.ugcBucket.get.mockClear();
    expect((await requestPreview("hidden", "other", { "If-None-Match": '"test"' })).status).toBe(
      404,
    );
    expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
    const overview = await requestPath("/overview", "author");
    expect(await overview.json()).toMatchObject({
      contributions: { imageCount: 4, pendingCount: 0 },
    });
  },
);

it.each([
  {
    name: "automatic approval",
    decision: "approved",
    source: "ai",
    steps: ["uploaded", "ai", "public"],
  },
  {
    name: "automatic escalation",
    decision: "pending_audit",
    source: "ai",
    steps: ["uploaded", "ai", "manual"],
  },
  {
    name: "manual approval before automation",
    decision: "approved",
    source: "admin",
    steps: ["uploaded", "manual", "public"],
  },
  {
    name: "manual rejection before automation",
    decision: "rejected",
    source: "admin",
    steps: ["uploaded", "manual", "archived"],
  },
  {
    name: "manual takeover",
    decision: "pending_audit",
    source: "admin",
    steps: ["uploaded", "manual"],
  },
] as const)("serializes real snapshot history for $name", async ({ decision, source, steps }) => {
  insertUser(database.sqlite, { uid: "admin", role: "a" });
  insertImageSnapshot(database.sqlite, {
    id: "reviewed",
    snapshotId: "actual-pk",
    userId: "author",
    reviewStatus: "pending_openai",
  });
  const target = (await getReviewTarget(database.db, "reviewed", "actual-pk"))!;
  const result = await reviewSnapshot(database.db, {
    target,
    expectedReviewStatus: "pending_openai",
    auditId: "audit-1",
    note: "Decision note",
    ...(source === "ai"
      ? { source, decision: decision as "approved" | "pending_audit" }
      : { source, decision, adminUserId: "admin" }),
  });
  expect(result.outcome).toBe("committed");
  const item = (await listOwnerContributions()).items.find((item) => item.id === "reviewed")!;
  expect(item.reviewStatus).toBe(decision);
  expect(item.review.path.map((step) => step.key)).toEqual(steps);
  expect(item.review.events).toEqual([
    {
      id: "audit-1",
      snapshotId: "actual-pk",
      from: "pending_openai",
      to: decision,
      source,
      adminUserId: source === "admin" ? "admin" : null,
      note: "Decision note",
      at: expect.any(String),
    },
  ]);
  const saved = database.sqlite
    .prepare("SELECT created_at FROM ugc_snapshots_review_audit WHERE id='audit-1'")
    .get()!;
  expect(item.review.events[0]!.at).toBe(saved.created_at);
});

it.each(["approved", "rejected"] as const)(
  "retains both real stages when manual review ends in %s",
  async (decision) => {
    insertUser(database.sqlite, { uid: "admin", role: "a" });
    insertImageSnapshot(database.sqlite, {
      id: "reviewed",
      userId: "author",
      reviewStatus: "pending_openai",
    });
    await reviewSnapshot(database.db, {
      target: (await getReviewTarget(database.db, "reviewed"))!,
      expectedReviewStatus: "pending_openai",
      auditId: "z-first",
      source: "ai",
      decision: "pending_audit",
    });
    await reviewSnapshot(database.db, {
      target: (await getReviewTarget(database.db, "reviewed"))!,
      expectedReviewStatus: "pending_audit",
      auditId: "a-second",
      source: "admin",
      adminUserId: "admin",
      decision,
    });
    const item = (await listOwnerContributions()).items.find((item) => item.id === "reviewed")!;
    expect(item.review.events.map((event) => [event.id, event.from, event.to])).toEqual([
      ["z-first", "pending_openai", "pending_audit"],
      ["a-second", "pending_audit", decision],
    ]);
    expect(item.review.path.map((step) => step.key)).toEqual([
      "uploaded",
      "ai",
      "manual",
      decision === "approved" ? "public" : "archived",
    ]);
  },
);

it("freshly selects the owner's current file after a warmed page and never serves the previous file", async () => {
  await listOwnerContributions();
  database.sqlite.exec(`INSERT INTO ugc_snapshots
    (id,submission_id,kind,revision,file_path,mime_type,review_status,creator_user_id)
    VALUES ('new-file','photo','image',2,'images/new-file.webp','image/webp','pending_openai','author');
    UPDATE ugc_submissions SET revision=2 WHERE id='photo';`);
  const preview = await requestPreview("photo", "author");
  expect(preview.status).toBe(200);
  expect(mocks.ugcBucket.get).toHaveBeenCalledExactlyOnceWith("images/new-file.webp", {
    onlyIf: expect.any(Headers),
  });
  mocks.ugcBucket.get.mockClear();
  expect((await requestPreview("photo", "other", { "If-None-Match": '"test"' })).status).toBe(404);
  expect(mocks.ugcBucket.get).not.toHaveBeenCalled();
});
