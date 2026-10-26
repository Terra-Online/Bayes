import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { runWithAuthRequest } from "@/lib/auth/betterAuth";
import { PublicReadCache } from "@/publicRead/origin/entrypoint";
import type { PublicSubmissionComment } from "@/repositories/submission/types";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type SessionHeaders } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { Bindings } from "@/types/app";

const workersCache = vi.hoisted(() => ({
  fetch: vi.fn<(request: Request, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: workersCache },
  WorkerEntrypoint: class {
    constructor(
      protected ctx: ExecutionContext,
      protected env: Bindings,
    ) {}
  },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

let database: TestDatabase;
let bindings: MockBindings;
let app: ReturnType<typeof createApp>;
let viewerHeaders: SessionHeaders;
let lifetimes: Promise<unknown>[][];

beforeEach(() => {
  workersCache.fetch.mockReset();
  database = createTestDatabase();
  viewerHeaders = insertAuthenticatedUser(database.sqlite, { uid: "viewer" }).headers;
  insertUser(database.sqlite, { uid: "other" });
  bindings = createMockBindings({ DB: database.db });
  bindings.bindings.UGC_ASSET_BASE_URL = "https://assets.example";
  bindings.bindings.UGC_UPLOAD_TEST_PREFIX = "";
  app = createApp();
  lifetimes = [];
  // Simulate the external Workers transport while executing the actual origin and SQL.
  workersCache.fetch.mockImplementation((request: Request) => {
    const pending: Promise<unknown>[] = [];
    lifetimes.push(pending);
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext;
    return new PublicReadCache(ctx, bindings.bindings).fetch(request);
  });
});
afterEach(async () => {
  await Promise.all(lifetimes.flat());
  vi.restoreAllMocks();
  database.close();
});

async function request(path: string, headers?: HeadersInit) {
  const pending: Promise<unknown>[] = [];
  lifetimes.push(pending);
  return runWithAuthRequest(() =>
    app.request(`https://api.example.com/uploads/v1${path}`, { headers }, bindings.bindings, {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext),
  );
}
function submissionQueries() {
  return database.queries.filter(({ sql }) => /ugc_submissions/.test(sql));
}
function reactionQueries() {
  return submissionQueries().filter(
    ({ sql }) => /AS viewer_(upvoted|vote)/.test(sql) && !/WITH/.test(sql),
  );
}

// Returned-ID SQL observation protects the read budget; authentication queries are separate.
describe("personalized UGC cache overlays", () => {
  it("only requests reactions for images returned by the public cache", async () => {
    insertSubmission(database.sqlite, { id: "image-1", userId: "other", kind: "image" });
    insertSubmission(database.sqlite, {
      id: "not-returned",
      userId: "other",
      kind: "image",
      createdAt: "2026-09-01",
    });
    database.sqlite.exec(
      "INSERT INTO ugc_submission_upvotes (submission_id, user_id, active) VALUES ('image-1', 'viewer', 1), ('not-returned', 'viewer', 1)",
    );
    const response = await request(
      "/images?markerIds=marker-1,marker-2&scope=prod&limit=1",
      viewerHeaders,
    );
    expect(reactionQueries()).toHaveLength(1);
    expect(reactionQueries()[0]!.values).toEqual([
      "viewer",
      '["marker-1","marker-2"]',
      '["image-1"]',
      "\\_test/%",
    ]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      items: [{ id: "image-1", upvoted: true, flagged: false }],
    });
  });

  it("includes returned nested replies in reaction lookups while preserving pending roots", async () => {
    for (const [id, parentId, depth] of [
      ["root", null, 0],
      ["reply", "root", 1],
      ["nested", "reply", 2],
    ] as const) {
      insertSubmission(database.sqlite, { id, parentId, depth, userId: "other" });
    }
    insertSubmission(database.sqlite, { id: "pending", userId: "viewer", status: "pending_audit" });
    insertSubmission(database.sqlite, {
      id: "other-pending",
      userId: "other",
      status: "pending_audit",
    });
    insertSubmission(database.sqlite, {
      id: "pending-reply",
      userId: "viewer",
      parentId: "reply",
      depth: 2,
      status: "pending_openai",
    });
    database.sqlite
      .exec(`INSERT INTO ugc_submission_votes (submission_id, user_id, value) VALUES ('nested', 'viewer', -1), ('root', 'other', 1);
      INSERT INTO ugc_submission_flags (submission_id, user_id, active) VALUES ('nested', 'viewer', 1), ('root', 'other', 1);`);
    const response = await request("/comments?markerId=marker-1", viewerHeaders);
    expect(reactionQueries()).toHaveLength(1);
    expect(reactionQueries()[0]!.values).toEqual([
      "viewer",
      '["marker-1"]',
      '["root","reply","nested"]',
    ]);
    expect(submissionQueries().find(({ sql }) => /LIMIT \?3/.test(sql))!.values).toEqual([
      "viewer",
      '["marker-1"]',
      200,
    ]);
    const payload = (await response.json()) as { items: PublicSubmissionComment[] };
    expect(payload.items.map((item) => item.id)).toEqual(["pending", "root"]);
    const publicRoot = payload.items[1]!;
    const publicReply = publicRoot.replies[0]!;
    expect(publicRoot).toMatchObject({ viewerVote: 0, flagged: false });
    expect(publicReply.replies[0]).toMatchObject({
      id: "nested",
      viewerVote: -1,
      flagged: true,
    });
    expect(publicReply).toMatchObject({
      replyCount: 2,
      replies: [
        expect.objectContaining({ id: "nested" }),
        expect.objectContaining({ id: "pending-reply", status: "pending_openai" }),
      ],
    });
    const anonymous = await request("/comments?markerId=marker-1");
    const publicPayload = (await anonymous.json()) as { items: PublicSubmissionComment[] };
    expect(publicPayload.items.map((item) => item.id)).toEqual(["root"]);
    expect(publicPayload.items[0]!.replies[0]).toMatchObject({
      replyCount: 1,
      replies: [expect.objectContaining({ id: "nested" })],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(["images", "comments"])(
    "keeps partial metadata for authenticated %s responses",
    async (kind) => {
      workersCache.fetch.mockImplementation(async (request: Request) =>
        new URL(request.url).searchParams.get("markerId") === "marker-1"
          ? Response.json({ items: [] })
          : Response.json({}, { status: 503 }),
      );
      const response = await request(
        `/${kind}?markerIds=marker-1,failed-1,failed-2`,
        viewerHeaders,
      );
      expect(await response.json()).toEqual({
        items: [],
        partial: true,
        failedMarkerIds: ["failed-1", "failed-2"],
      });
      expect(response.headers.get("x-oem-partial-response")).toBe("true");
      expect(response.headers.get("x-oem-failed-marker-count")).toBe("2");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(reactionQueries()).toEqual([]);
      // An empty public result still reads the viewer's pending comments.
      expect(submissionQueries()).toHaveLength(kind === "comments" ? 1 : 0);
    },
  );

  it.each(["images", "comments"])(
    "preserves %s origin errors without a viewer lookup",
    async (kind) => {
      workersCache.fetch.mockImplementation(async () => Response.json({}, { status: 503 }));
      const response = await request(`/${kind}?markerId=marker-1`, viewerHeaders);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(submissionQueries()).toEqual([]);
    },
  );

  it.each(["images", "comments"])(
    "keeps public cache policy when %s identity is absent",
    async (kind) => {
      workersCache.fetch.mockImplementation(async () => Response.json({ items: [] }));
      const response = await request(`/${kind}?markerId=marker-1`, {
        authorization: "Bearer invalid-session",
      });
      expect(await response.json()).toEqual({ items: [] });
      expect(response.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
      expect(submissionQueries()).toEqual([]);
    },
  );

  it.each(["images", "comments"])(
    "does not read viewer state for anonymous or public-only %s",
    async (kind) => {
      workersCache.fetch.mockImplementation(async () => Response.json({ items: [] }));
      for (const publicOnly of [false, true]) {
        const response = await request(
          `/${kind}?markerId=marker-1${publicOnly ? "&publicOnly=1" : ""}`,
          publicOnly ? viewerHeaders : undefined,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
      }
      expect(database.queries).toEqual([]);
    },
  );
});

describe("combined point image reads", () => {
  it("shares the authenticated user, keeps private results outside the public cache", async () => {
    insertSubmission(database.sqlite, {
      id: "public",
      userId: "other",
      kind: "image",
      markerId: "m",
      filePath: "_test/public.webp",
    });
    insertSubmission(database.sqlite, {
      id: "pending",
      userId: "viewer",
      kind: "image",
      markerId: "m",
      status: "pending_audit",
      filePath: "_test/pending.webp",
    });
    const response = await request("/images?includeMine=1&markerId=m&scope=test", viewerHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      images: { items: [{ id: "public" }] },
      mine: { items: [{ id: "pending" }] },
    });
    expect(
      submissionQueries().find(({ sql }) => /idx_ugc_user_kind_poi_created/.test(sql))!.values,
    ).toEqual(["viewer", '["m"]', "\\_test/%", 6]);
    expect(reactionQueries()[0]!.values).toEqual(["viewer", '["m"]', '["public"]', "\\_test/%"]);
    // Private selection and credentials must never enter the shared cache request.
    const cachedRequest = workersCache.fetch.mock.calls[0]![0] as Request;
    expect([...new URL(cachedRequest.url).searchParams.keys()]).toEqual([
      "markerId",
      "limit",
      "namespace",
      "assetBaseUrl",
    ]);
    const headerNames: string[] = [];
    cachedRequest.headers.forEach((_value, name) => headerNames.push(name));
    expect(headerNames).toEqual([]);
  });

  it.each(["images", "mine"])("preserves the other section when %s fails", async (part) => {
    // A generic public-section error is a D1 overlay failure (500). External
    // fetch failures are translated by the real client and would yield section 503.
    workersCache.fetch.mockImplementation(async () =>
      Response.json({ items: part === "images" ? [{ id: "public", markerId: "m" }] : [] }),
    );
    database.hooks.beforeQuery = (sql) => {
      if (
        part === "images"
          ? /AS viewer_upvoted/.test(sql)
          : /idx_ugc_user_kind_poi_created/.test(sql)
      ) {
        throw new Error("private diagnostic");
      }
    };
    const response = await request("/images?includeMine=1&markerId=m", viewerHeaders);
    expect(response.status).toBe(207);
    expect(response.headers.get("x-oem-partial-response")).toBe("true");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body[part]).toMatchObject({ error: { status: 500 } });
    expect(body[part === "images" ? "mine" : "images"]).toEqual({ items: [] });
    expect(JSON.stringify(body)).not.toContain("private diagnostic");
  });

  it("preserves failed marker IDs alongside pending images", async () => {
    workersCache.fetch.mockImplementation(async (request: Request) =>
      new URL(request.url).searchParams.get("markerId") === "m"
        ? Response.json({}, { status: 503 })
        : Response.json({ items: [] }),
    );
    insertSubmission(database.sqlite, {
      id: "pending",
      userId: "viewer",
      kind: "image",
      markerId: "m",
      status: "pending_audit",
    });
    const response = await request("/images?includeMine=1&markerIds=m,empty", viewerHeaders);
    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      images: { failedMarkerIds: ["m"] },
      mine: { items: [{ id: "pending" }] },
    });
  });
});

describe("public list cache failures through HTTP", () => {
  it("returns successful markers as an uncacheable partial response", async () => {
    workersCache.fetch.mockImplementation((request: Request) => {
      const markerId = new URL(request.url).searchParams.get("markerId");
      if (markerId === "failed") {
        return Promise.reject(new Error("Network connection lost."));
      }
      return Promise.resolve(
        Response.json({
          items: [{ id: "image-1", markerId }],
        }),
      );
    });

    const response = await request("/images?markerIds=success,failed");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-oem-partial-response")).toBe("true");
    expect(response.headers.get("x-oem-failed-marker-count")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      items: [{ id: "image-1", markerId: "success" }],
      partial: true,
      failedMarkerIds: ["failed"],
    });
  });

  it("returns an error when every marker read fails", async () => {
    workersCache.fetch.mockRejectedValue(new Error("Network connection lost."));

    const response = await request("/images?markerIds=first,second");

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "PUBLIC_CACHE_READ_FAILED",
    });
  });
  it("keeps partial responses uncacheable and propagates overload backoff without retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    workersCache.fetch.mockImplementation(async (request: Request) => {
      if (new URL(request.url).searchParams.get("markerId") === "failed") {
        return Response.json({}, { status: 503 });
      }
      return Response.json({ items: [] });
    });
    const partial = await request("/comments?markerIds=empty,failed");
    expect(partial.status).toBe(200);
    expect(partial.headers.get("cache-control")).toBe("private, no-store");
    expect(await partial.json()).toEqual({ items: [], partial: true, failedMarkerIds: ["failed"] });
    const failed = await request("/comments?markerId=failed");
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("5");
    expect(workersCache.fetch).toHaveBeenCalledTimes(3);
  });

  it("handles platform overload before the cache entrypoint is reached", async () => {
    workersCache.fetch.mockRejectedValue(
      Object.assign(new Error("Too much work queued"), { overloaded: true }),
    );
    const response = await request("/images?markerId=failed");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(workersCache.fetch).toHaveBeenCalledTimes(1);
  });
});
