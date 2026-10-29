import { resolve } from "node:path";

import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { appendCommentVersion } from "@/repositories/submission/appendCommentVersion";
import { getReviewTarget, reviewSnapshot } from "@/repositories/submission/reviewSnapshot";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { createModerationTestFixture } from "@/test/fixtures/moderation";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";

const redisCounts = vi.hoisted(() => new Map<string, number>());
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async incrby(key: string, amount: number) {
      const next = (redisCounts.get(key) ?? 0) + amount;
      redisCounts.set(key, next);
      return next;
    }
    async expire() {
      return 1;
    }
  },
}));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: async () => ({ success: true }) } },
}));
// Opt-in test adapter loads the real client from the supplied checkout. No Cor
// source or checkout path is embedded in the Bayes product or ordinary CI suite.
interface ClientRow {
  id: string;
  reviewStatus: string;
  snapshotId: string;
  frontier: { snapshotId: string; content: string | null };
  publicSnapshot: { snapshotId: string; content: string | null } | null;
  reportSnapshotId: string;
  adminDeletedAt: string | null;
  flagCount: number;
}
interface Client {
  listPendingSubmissions(options: Record<string, unknown>): Promise<{
    items: ClientRow[];
    nextOffset: number | null;
    offset: number;
    stats: { total: number };
  }>;
  performModerationAction(
    id: string,
    command: Record<string, unknown>,
  ): Promise<{ outcome: string; actorUserId: string }>;
}
let client: Client;
let fixture: ReturnType<typeof createModerationTestFixture>;
let cookie: Record<string, string>;
beforeAll(async () => {
  if (!process.env.COR_REPO_ROOT) {
    throw new Error(
      "Set COR_REPO_ROOT to the installed Cor checkout; see scripts/cor-client-contract.md",
    );
  }
  vi.stubEnv("VITE_DATA_API_BASE", "http://cor-contract.test");
  client = await import(/* @vite-ignore */ resolve(process.env.COR_REPO_ROOT, "src/api.ts"));
});
beforeEach(() => {
  fixture = createModerationTestFixture();
  importCurrentSubmissions(fixture.database);
  cookie = fixture.createReviewerSession("a", "admin");
  redisCounts.clear();
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.origin !== "http://cor-contract.test") {
      throw new Error(`Unexpected external fetch: ${url.origin}`);
    }
    expect(init?.credentials).toBe("include");
    const path = url.pathname.replace(/^\/moderation\/v1/, "") + url.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return fixture.request(path, { method: init?.method, headers: cookie, body });
  });
});
afterEach(() => {
  fixture?.database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sends public A clear separately from exact B review through real cookie authentication, then rejects stale phase retries", async () => {
  insertCommentSnapshot(fixture.database.sqlite, {
    id: "comment",
    userId: "author",
    content: "Public A",
  });
  const edit = await appendCommentVersion(fixture.database.db, {
    submissionId: "comment",
    parentSnapshotId: "snapshot-comment",
    content: "Frontier B",
    actorId: "author",
    snapshotId: "B",
  });
  expect(edit.outcome).toBe("appended");
  fixture.database.sqlite.exec(
    "INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('comment','admin')",
  );
  const [row] = (await client.listPendingSubmissions({ submissionId: "comment" })).items;
  expect(row.publicSnapshot).toMatchObject({ snapshotId: "snapshot-comment", content: "Public A" });
  expect(row.frontier.content).toBe("Frontier B");
  expect(row.reportSnapshotId).toBe("snapshot-comment");
  expect(
    await client.performModerationAction(row.id, {
      action: "clear_flags",
      snapshotId: row.reportSnapshotId,
    }),
  ).toMatchObject({ outcome: "committed", actorUserId: "admin" });
  expect((await client.listPendingSubmissions({ submissionId: row.id })).items[0]).toMatchObject({
    reviewStatus: "pending_openai",
    flagCount: 0,
  });
  const automaticTarget = await getReviewTarget(
    fixture.database.db,
    row.id,
    row.frontier.snapshotId,
  );
  expect(automaticTarget).not.toBeNull();
  const takeover = {
    action: "send_to_manual",
    snapshotId: row.frontier.snapshotId,
    expectedReviewStatus: row.reviewStatus,
  };
  await client.performModerationAction(row.id, takeover);
  await expect(client.performModerationAction(row.id, takeover)).rejects.toMatchObject({
    status: 409,
    code: "MODERATION_CONFLICT",
  });
  // Late automatic work cannot overwrite the earlier real client takeover.
  expect(
    await reviewSnapshot(fixture.database.db, {
      target: automaticTarget!,
      auditId: "late-ai",
      expectedReviewStatus: "pending_openai",
      decision: "approved",
      source: "ai",
    }),
  ).toMatchObject({ outcome: "ignored" });
  await expect(client.performModerationAction(row.id, { status: "active" })).rejects.toMatchObject({
    status: 422,
  });
  await client.performModerationAction(row.id, {
    action: "approve",
    snapshotId: row.frontier.snapshotId,
    expectedReviewStatus: "pending_audit",
  });
  expect((await client.listPendingSubmissions({ submissionId: row.id })).items[0]).toMatchObject({
    reviewStatus: "approved",
    publicSnapshot: { content: "Frontier B" },
  });
  await expect(
    client.performModerationAction(row.id, {
      action: "clear_flags",
      snapshotId: row.reportSnapshotId,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    client.performModerationAction(row.id, {
      action: "approve",
      snapshotId: row.frontier.snapshotId,
      expectedReviewStatus: "pending_audit",
    }),
  ).rejects.toMatchObject({ status: 409 });
});

it("traverses old hidden image/comment reports, ignores queue dates and limits for deep links, and clears without restoring", async () => {
  insertImageSnapshot(fixture.database.sqlite, {
    id: "image",
    userId: "author",
    reviewStatus: "rejected",
    createdAt: "2020-01-01",
  });
  insertCommentSnapshot(fixture.database.sqlite, {
    id: "comment",
    userId: "author",
    reviewStatus: "unknown",
    createdAt: "2020-01-02",
  });
  fixture.database.sqlite.exec(
    "UPDATE ugc_submissions SET author_deleted_at='2020-01-03'; INSERT INTO ugc_submission_flags(submission_id,user_id) VALUES ('image','admin'),('comment','admin')",
  );
  const options = {
    mode: "reports",
    statuses: ["pending_openai"],
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-29T00:00:00.000Z",
    limit: 1,
  };
  const first = await client.listPendingSubmissions(options);
  expect(first.items.map((row) => row.id)).toEqual(["image"]);
  expect(first.stats.total).toBe(2);
  const second = await client.listPendingSubmissions({ ...options, offset: first.nextOffset });
  expect(second.items.map((row) => row.id)).toEqual(["comment"]);
  expect(second.nextOffset).toBeNull();
  const lookup = await client.listPendingSubmissions({
    ...options,
    submissionId: "comment",
    offset: 999,
  });
  expect(lookup.items[0].id).toBe("comment");
  for (const row of [first.items[0], second.items[0]]) {
    expect(row.publicSnapshot).toBeNull();
    await client.performModerationAction(row.id, {
      action: "clear_flags",
      snapshotId: row.reportSnapshotId,
    });
    expect(
      await client.performModerationAction(row.id, {
        action: "clear_flags",
        snapshotId: row.reportSnapshotId,
      }),
    ).toMatchObject({ outcome: "no_op" });
    const retained = (await client.listPendingSubmissions({ submissionId: row.id })).items[0];
    expect(retained.publicSnapshot).toBeNull();
    expect(retained.reviewStatus).toBe(row.reviewStatus);
  }
  expect(
    (await client.listPendingSubmissions({ mode: "reports", limit: 1, offset: 0 })).stats.total,
  ).toBe(0);
});

it("keeps independently committed bulk results when another captured row conflicts and disable remains a separate fact", async () => {
  insertCommentSnapshot(fixture.database.sqlite, {
    id: "one",
    userId: "author",
    reviewStatus: "pending_audit",
  });
  insertCommentSnapshot(fixture.database.sqlite, {
    id: "two",
    userId: "author",
    reviewStatus: "pending_audit",
  });
  const rows = (await client.listPendingSubmissions({ limit: 100 })).items;
  await client.performModerationAction("one", { action: "disable", snapshotId: "snapshot-one" });
  expect(
    await client.performModerationAction("one", { action: "disable", snapshotId: "snapshot-one" }),
  ).toMatchObject({ outcome: "no_op" });
  const results = await Promise.allSettled(
    rows.map((row) =>
      client.performModerationAction(row.id, {
        action: "reject",
        snapshotId: row.frontier.snapshotId,
        expectedReviewStatus: row.reviewStatus,
      }),
    ),
  );
  expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  if (results[0].status === "rejected") {
    expect(results[0].reason).toMatchObject({ status: 409 });
  }
  const current = (await client.listPendingSubmissions({ limit: 100 })).items;
  expect(current.find((row) => row.id === "one")).toMatchObject({
    reviewStatus: "pending_audit",
    adminDeletedAt: expect.any(String),
  });
  expect(current.find((row) => row.id === "two")).toMatchObject({
    reviewStatus: "rejected",
    adminDeletedAt: null,
  });
  cookie = {};
  await expect(client.listPendingSubmissions({ limit: 1 })).rejects.toMatchObject({ status: 401 });
});
