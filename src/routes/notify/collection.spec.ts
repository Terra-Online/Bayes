import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { getReviewTarget, reviewSnapshot } from "@/repositories/submission/reviewSnapshot";
import { setSubmissionVote } from "@/repositories/submission/voteSubmission";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type SessionHeaders } from "@/test/fixtures/auth";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import type { AuthUser } from "@/types/app";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

let database: TestDatabase;
let headers: SessionHeaders;
let bindings: ReturnType<typeof createMockBindings>;

beforeEach(() => {
  database = createTestDatabase();
  headers = insertAuthenticatedUser(database.sqlite, { uid: "owner" }).headers;
  insertAuthenticatedUser(database.sqlite, { uid: "voter" });
  insertCommentSnapshot(database.sqlite, { id: "comment", userId: "owner" });
  bindings = createMockBindings({ DB: database.db });
  bindings.authRateLimit.limit.mockResolvedValue({ success: true });
  bindings.notificationObjects.idFromName.mockImplementation(
    (name) =>
      ({
        toString: () => name,
        equals: () => false,
      }) as DurableObjectId,
  );
  bindings.notificationObjects.get.mockReturnValue({
    fetch: vi.fn<Fetcher["fetch"]>().mockResolvedValue(new Response(null, { status: 204 })),
  } as unknown as DurableObjectStub);
});
afterEach(() => {
  vi.useRealTimers();
  database.close();
});

function request(path: string, method = "GET") {
  const app = new Hono<AppEnv>().onError(onAppError).route("/notify/v1", createRoutes());
  return app.request(`http://localhost/notify/v1${path}`, { method, headers }, bindings.bindings, {
    waitUntil: () => {},
  } as unknown as ExecutionContext);
}

it("collects a committed like on explicit sync without making inbox reads collect, and preserves reads on retry", async () => {
  await setSubmissionVote(database.db, {
    submissionId: "comment",
    actor: { uid: "voter" } as AuthUser,
    value: 1,
  });
  expect(await (await request("/community/messages")).json()).toMatchObject({
    items: [],
    unread: { total: 0 },
  });
  const sync = await request("/sync", "POST");
  expect(sync.status).toBe(200);
  expect(await sync.json()).toMatchObject({ ok: true, unread: { community: 1, total: 1 } });
  const page = (await (await request("/community/messages")).json()) as { items: { id: string }[] };
  expect(page.items).toEqual([
    expect.objectContaining({
      type: "community.comment.vote",
      isMultiMsg: false,
      messages: [],
      target: expect.objectContaining({ submissionId: "comment" }),
      readAt: null,
    }),
  ]);
  await request(`/community/messages/${page.items[0].id}/read`, "PATCH");
  await request("/sync", "POST");
  expect(await (await request("/community/messages")).json()).toMatchObject({
    items: [{ id: page.items[0].id, readAt: expect.any(String) }],
    unread: { total: 0 },
  });
});

it("projects first reply publication separately from the author's review result", async () => {
  insertCommentSnapshot(database.sqlite, {
    id: "reply",
    userId: "voter",
    parentId: "comment",
    reviewStatus: "pending_openai",
  });
  const result = await reviewSnapshot(database.db, {
    target: (await getReviewTarget(database.db, "reply"))!,
    expectedReviewStatus: "pending_openai",
    decision: "approved",
    source: "ai",
    auditId: "reply-approved",
  });
  expect(result.outcome).toBe("committed");
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
  expect((await request("/sync", "POST")).status).toBe(200);
  expect(await (await request("/community/messages")).json()).toMatchObject({
    items: [
      {
        type: "community.comment.reply",
        target: { submissionId: "reply", parentSubmissionId: "comment" },
      },
    ],
    unread: { community: 1, total: 1 },
  });
  expect(
    database.sqlite.prepare("SELECT * FROM notifications WHERE recipient_user_id='voter'").all(),
  ).toEqual([]);
});

it("keeps each same-millisecond activation, even when cancelled before collection", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T00:00:00.000Z"));
  for (const value of [1, 1, 1] as const) {
    await setSubmissionVote(database.db, {
      submissionId: "comment",
      actor: { uid: "voter" } as AuthUser,
      value,
    });
  }
  await request("/sync", "POST");
  const page = (await (await request("/community/messages")).json()) as { items: { id: string }[] };
  expect(page.items).toHaveLength(2);
  expect(new Set(page.items.map((item) => item.id)).size).toBe(2);
  expect(
    database.sqlite
      .prepare("SELECT previous_value,next_value FROM ugc_vote_events ORDER BY event_sequence")
      .all(),
  ).toEqual([
    { previous_value: 0, next_value: 1 },
    { previous_value: 1, next_value: 0 },
    { previous_value: 0, next_value: 1 },
  ]);
});

it("skips uncollected events beyond fourteen days, includes the boundary, and retains old inbox entries", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  for (const [at, value] of [
    ["2026-10-27T23:59:59.999Z", 1],
    ["2026-10-28T00:00:00.000Z", 1],
    ["2026-10-28T00:00:00.000Z", 1],
  ] as const) {
    vi.setSystemTime(new Date(at));
    await setSubmissionVote(database.db, {
      submissionId: "comment",
      actor: { uid: "voter" } as AuthUser,
      value,
    });
  }
  database.sqlite
    .exec(`INSERT INTO notifications(id,recipient_user_id,category,type,dedupe_key,created_at)
    VALUES('old-inbox','owner','community','community.comment.vote','old-inbox','2020-01-01T00:00:00.000Z')`);
  vi.setSystemTime(new Date("2026-11-11T00:00:00.000Z"));
  await request("/sync", "POST");
  const page = (await (await request("/community/messages")).json()) as { items: { id: string }[] };
  expect(page.items).toHaveLength(2);
  expect(page.items.some((item) => item.id === "old-inbox")).toBe(true);
  expect(
    database.sqlite
      .prepare(
        "SELECT last_event_sequence FROM notification_collection_progress WHERE source_kind='vote'",
      )
      .get(),
  ).toEqual({ last_event_sequence: 3 });
  expect(await (await request("/sync", "POST")).json()).toMatchObject({ unread: { total: 2 } });
});

it("rolls projection and progress back together and retries after a failed batch", async () => {
  await setSubmissionVote(database.db, {
    submissionId: "comment",
    actor: { uid: "voter" } as AuthUser,
    value: 1,
  });
  database.sqlite
    .exec(`CREATE TRIGGER fail_progress BEFORE UPDATE ON notification_collection_progress
    BEGIN SELECT RAISE(ABORT,'progress unavailable'); END;`);
  expect((await request("/sync", "POST")).status).toBe(500);
  expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
  expect(database.sqlite.prepare("SELECT * FROM notification_collection_progress").all()).toEqual(
    [],
  );
  expect(database.sqlite.prepare("SELECT * FROM notification_counters").all()).toEqual([]);
  database.sqlite.exec("DROP TRIGGER fail_progress");
  expect(await (await request("/sync", "POST")).json()).toMatchObject({ unread: { total: 1 } });
});

it("serializes concurrent collectors without duplicating notifications or unread counts", async () => {
  for (let index = 0; index < 3; index++) {
    await setSubmissionVote(database.db, {
      submissionId: "comment",
      actor: { uid: "voter" } as AuthUser,
      value: 1,
    });
  }
  const responses = await Promise.all(Array.from({ length: 6 }, () => request("/sync", "POST")));
  expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200));
  expect(await (await request("/unread-count")).json()).toEqual({
    unread: { system: 0, community: 2, total: 2 },
  });
  expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get()).toEqual({
    count: 2,
  });
  expect(
    database.sqlite
      .prepare(
        "SELECT last_event_sequence FROM notification_collection_progress WHERE source_kind='vote'",
      )
      .get(),
  ).toEqual({ last_event_sequence: 3 });
});

it("advances past silent self-interactions and downvotes, and leaves later projections unread after read-all", async () => {
  await setSubmissionVote(database.db, {
    submissionId: "comment",
    actor: { uid: "owner" } as AuthUser,
    value: 1,
  });
  await setSubmissionVote(database.db, {
    submissionId: "comment",
    actor: { uid: "voter" } as AuthUser,
    value: -1,
  });
  await request("/sync", "POST");
  expect(await (await request("/unread-count")).json()).toMatchObject({ unread: { total: 0 } });
  expect(
    database.sqlite
      .prepare(
        "SELECT last_event_sequence FROM notification_collection_progress WHERE source_kind='vote'",
      )
      .get(),
  ).toEqual({ last_event_sequence: 2 });
  await setSubmissionVote(database.db, {
    submissionId: "comment",
    actor: { uid: "voter" } as AuthUser,
    value: 1,
  });
  await request("/community/read-all", "POST");
  await request("/sync", "POST");
  expect(await (await request("/community/messages")).json()).toMatchObject({
    items: [{ readAt: null }],
    unread: { community: 1, total: 1 },
  });
});

it("requires the authenticated user's rate limit for explicit collection", async () => {
  bindings.authRateLimit.limit.mockResolvedValue({ success: false });
  expect((await request("/sync", "POST")).status).toBe(429);
  expect(database.sqlite.prepare("SELECT * FROM notification_collection_progress").all()).toEqual(
    [],
  );
});

it("continues a finite source page on the next sync without skipping its tail", async () => {
  const insert = database.sqlite.prepare(`INSERT INTO ugc_vote_events
    (id,submission_id,actor_user_id,previous_value,next_value,created_at)
    VALUES(?,'comment','voter',?,?,?)`);
  const now = new Date().toISOString();
  for (let index = 0; index < 201; index++) {
    insert.run(`page-${index}`, index % 2, 1 - (index % 2), now);
  }
  await request("/sync", "POST");
  expect(await (await request("/unread-count")).json()).toMatchObject({ unread: { total: 100 } });
  expect(
    database.sqlite
      .prepare(
        "SELECT last_event_sequence FROM notification_collection_progress WHERE source_kind='vote'",
      )
      .get(),
  ).toEqual({ last_event_sequence: 200 });
  await request("/sync", "POST");
  expect(await (await request("/unread-count")).json()).toMatchObject({ unread: { total: 101 } });
  expect(
    database.sqlite
      .prepare(
        "SELECT last_event_sequence FROM notification_collection_progress WHERE source_kind='vote'",
      )
      .get(),
  ).toEqual({ last_event_sequence: 201 });
});
