import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { PublicReadCache } from "@/publicRead/origin/entrypoint";
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
  const kv = new Map<string, string>();
  bindings.bindings.OEM_KV = {
    get: vi.fn(async (key: string) => kv.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      kv.set(key, value);
    }),
  } as unknown as KVNamespace;
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

it("keeps public A cached while its author reads pending B with replies and reactions", async () => {
  insertSubmission(database.sqlite, {
    id: "root",
    userId: "viewer",
    content: "Published A",
    snapshotId: "A",
  });
  insertSubmission(database.sqlite, { id: "reply", userId: "other", parentId: "root", depth: 1 });
  database.sqlite.exec(
    "INSERT INTO ugc_submission_votes (submission_id,user_id,value) VALUES ('root','viewer',1)",
  );

  database.sqlite
    .exec(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,content,review_status,creator_user_id)
    VALUES ('B','root','comment',2,'Private B','pending_audit','viewer');
    UPDATE ugc_submissions SET revision=2 WHERE id='root';`);
  const anonymous = await request("/comments?markerId=marker-1");
  expect(anonymous.status).toBe(200);
  expect(await anonymous.json()).toMatchObject({
    items: [{ id: "root", snapshotId: "A", content: "Published A", status: "active" }],
  });
  await Promise.all(lifetimes.flat());
  const owner = await request("/comments?markerId=marker-1", viewerHeaders);
  expect(owner.status).toBe(200);
  expect(owner.headers.get("cache-control")).toBe("private, no-store");
  expect(await owner.json()).toMatchObject({
    items: [
      {
        id: "root",
        snapshotId: "B",
        content: "Private B",
        status: "pending_audit",
        score: 1,
        viewerVote: 1,
        replies: [{ id: "reply" }],
      },
    ],
  });
  const mine = await request("/comments/mine?markerId=marker-1", viewerHeaders);
  expect(await mine.json()).toMatchObject({ items: [{ snapshotId: "B", content: "Private B" }] });
  const context = await request("/comments/root?markerId=marker-1", viewerHeaders);
  expect(await context.json()).toMatchObject({
    item: { path: [{ snapshotId: "B", content: "Private B" }] },
  });
  const cached = await request("/comments?markerId=marker-1");
  expect(await cached.json()).toMatchObject({
    items: [{ snapshotId: "A", content: "Published A", replies: [{ id: "reply" }] }],
  });
});

it("blocks default traversal at hidden middle nodes but retains deep-link context filtering", async () => {
  for (const [id, parentId, depth, status] of [
    ["root", null, 0, "active"],
    ["hidden", "root", 1, "stale"],
    ["leaf", "hidden", 2, "active"],
  ] as const) {
    insertSubmission(database.sqlite, { id, parentId, depth, status, userId: "other" });
  }

  const list = await request("/comments?markerId=marker-1");
  expect(await list.json()).toMatchObject({ items: [{ id: "root", replyCount: 0, replies: [] }] });
  expect((await request("/comments/hidden?markerId=marker-1", viewerHeaders)).status).toBe(404);
  expect((await request("/comments/leaf?markerId=wrong")).status).toBe(404);
  const leaf = await request("/comments/leaf?markerId=marker-1");
  expect(await leaf.json()).toMatchObject({
    item: { path: [{ id: "root" }, { id: "leaf", parentId: "hidden" }], replies: [] },
  });
  const root = await request("/comments/root?markerId=marker-1");
  expect(await root.json()).toMatchObject({
    item: {
      path: [{ id: "root" }],
      replies: [{ id: "leaf", parentId: "hidden" }],
      repliesTruncated: false,
    },
  });
});

it("identifies the publicly selected translation body while an author has a newer pending version", async () => {
  insertSubmission(database.sqlite, {
    id: "root",
    userId: "viewer",
    content: "Public A",
    snapshotId: "A",
  });

  database.sqlite
    .exec(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,content,review_status,creator_user_id)
    VALUES ('B','root','comment',2,'Private B','pending_audit','viewer');
    UPDATE ugc_submissions SET revision=2 WHERE id='root';`);
  bindings.publicRateLimit.limit.mockResolvedValue({ success: true });
  const response = await app.request(
    "https://api.example.com/uploads/v1/comments/translations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentIds: ["root"], targetLanguage: "en-US", cachedOnly: true }),
    },
    bindings.bindings,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    items: [{ commentId: "root", snapshotId: "A", error: "TRANSLATION_CACHE_MISS" }],
  });
});

it("preserves per-marker vote ranking, reply order and limits without promoting hidden descendants", async () => {
  for (const markerId of ["marker-1", "marker-2"]) {
    for (const suffix of ["low", "high"]) {
      insertSubmission(database.sqlite, { id: `${markerId}-${suffix}`, markerId, userId: "other" });
    }
    for (const suffix of ["a", "b", "c"]) {
      insertSubmission(database.sqlite, {
        id: `${markerId}-reply-${suffix}`,
        markerId,
        userId: "other",
        parentId: `${markerId}-high`,
        depth: 1,
      });
      insertSubmission(database.sqlite, {
        id: `${markerId}-nested-${suffix}`,
        markerId,
        userId: "other",
        parentId: `${markerId}-reply-a`,
        depth: 2,
      });
    }
    database.sqlite
      .prepare(
        "INSERT INTO ugc_submission_votes (submission_id,user_id,value) VALUES (?,'viewer',1)",
      )
      .run(`${markerId}-high`);
  }

  const response = await request("/comments?markerIds=marker-1,marker-2&limit=1&replyLimit=2");
  const { items } = (await response.json()) as {
    items: Array<{
      id: string;
      replyCount: number;
      replies: Array<{ id: string; replies: Array<{ id: string }> }>;
    }>;
  };
  expect(items.map((item) => item.id)).toEqual(["marker-1-high", "marker-2-high"]);
  // The existing public cache slices direct replies only; nested cached replies retain their cache limit.
  expect(items[0]).toMatchObject({
    replyCount: 3,
    replies: [
      {
        id: "marker-1-reply-a",
        replies: [
          { id: "marker-1-nested-a" },
          { id: "marker-1-nested-b" },
          { id: "marker-1-nested-c" },
        ],
      },
      { id: "marker-1-reply-b", replies: [] },
    ],
  });
  const noReplies = await request("/comments?markerId=marker-1&limit=1&replyLimit=0");
  expect(await noReplies.json()).toMatchObject({
    items: [{ id: "marker-1-high", replyCount: 3, replies: [] }],
  });
});

it("keeps unavailable owner archives private and does not attach them as pending overlays", async () => {
  for (const id of ["rejected", "deleted", "disabled", "unknown"]) {
    insertSubmission(database.sqlite, { id, userId: "viewer" });
  }

  database.sqlite
    .exec(`UPDATE ugc_snapshots SET review_status='rejected' WHERE submission_id='rejected';
    UPDATE ugc_snapshots SET review_status='unknown' WHERE submission_id='unknown';
    UPDATE ugc_submissions SET author_deleted_at='gone' WHERE id='deleted';
    UPDATE ugc_submissions SET admin_deleted_at='gone',admin_deleted_by='other' WHERE id='disabled';`);
  const mine = await request("/comments/mine?markerId=marker-1", viewerHeaders);
  const payload = (await mine.json()) as {
    items: Array<{ id: string; snapshotId: string; status: string }>;
  };
  expect(payload.items.map((item) => item.id).sort()).toEqual([
    "deleted",
    "disabled",
    "rejected",
    "unknown",
  ]);
  expect(
    payload.items.every(
      (item) => item.status === "stale" && item.snapshotId === `snapshot-${item.id}`,
    ),
  ).toBe(true);
  const publicList = await request("/comments?markerId=marker-1", viewerHeaders);
  expect(await publicList.json()).toMatchObject({ items: [] });
});
