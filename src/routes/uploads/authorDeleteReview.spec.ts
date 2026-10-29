import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import {
  runAutoModerationQueueBatch,
  type LegacyAutoModerationMsg,
} from "@/queues/runtime/autoModeration";
import { insertAuthUser, insertSession } from "@/test/fixtures/auth";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { createModerationTestFixture } from "@/test/fixtures/moderation";

// The HTTP/auth/service/repository path stays real. Only external services and
// the Workers runtime import are replaced at their boundaries.
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
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
vi.mock("@/lib/karma/karmaConfig.json", () => ({
  default: {
    levels: [{ karma: 0, minPoints: 0 }],
    scoreRules: {
      moderation: {
        approvedImage: 6,
        approvedComment: 2,
        rejectedSubmission: -6,
        approvedImageDailyBackoff: { halfRewardAtCount: 6, counterTtlSeconds: 172800 },
        approvedCommentDailyBackoff: { halfRewardAtCount: 4, counterTtlSeconds: 172800 },
      },
    },
  },
}));

import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
let fixture: ReturnType<typeof createModerationTestFixture>;
let headers: { authorization: string };
beforeEach(() => {
  redisCounts.clear();
  fixture = createModerationTestFixture();
  importCurrentSubmissions(fixture.database);
  insertAuthUser(fixture.database.sqlite, { id: "author" });
  headers = insertSession(fixture.database.sqlite, { userId: "author" }).headers;
  fixture.env.LOCK_UPLOAD_ENDPOINTS = "false";
  fixture.env.OPENAI_API_KEY = "test-key";
  fixture.env.UGC_BUCKET = { get: async () => null } as unknown as R2Bucket;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ results: [{ flagged: false }] })),
  );
});
afterEach(() => {
  fixture.database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function remove(kind: "comment" | "image") {
  const pending: Promise<unknown>[] = [];
  const response = await createApp().request(
    `https://api.example.test/uploads/v1/${kind}s/target`,
    { method: "DELETE", headers },
    fixture.env,
    { waitUntil: (task: Promise<unknown>) => pending.push(task) } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
  expect(response.status).toBe(200);
}
for (const kind of ["comment", "image"] as const) {
  it(`HTTP ${kind} deletion during AI evaluation prevents audit, notifications and rewards`, async () => {
    (kind === "comment" ? insertCommentSnapshot : insertImageSnapshot)(fixture.database.sqlite, {
      id: "target",
      userId: "author",
      reviewStatus: "pending_openai",
    });
    vi.mocked(fetch).mockImplementation(async () => {
      await remove(kind);
      return Response.json({ results: [{ flagged: false }] });
    });
    const response = await fixture.request("/run", {
      method: "POST",
      headers: fixture.createReviewerSession("a"),
      body: { ids: ["target"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 0 });
    expect(
      fixture.database.sqlite.prepare("SELECT count(*) n FROM ugc_snapshots_review_audit").get(),
    ).toEqual({ n: 0 });
    expect(fixture.authorPoints()).toBe(20);
    expect(fixture.notificationMessages()).toEqual([]);
    expect(fixture.messages.webhook).toEqual([]);
    expect(fixture.messages.translation).toEqual([]);
    expect(redisCounts.size).toBe(0);
  });
  it(`HTTP ${kind} review first retains rewards and notifications after deletion and late redelivery`, async () => {
    (kind === "comment" ? insertCommentSnapshot : insertImageSnapshot)(fixture.database.sqlite, {
      id: "target",
      userId: "author",
      reviewStatus: "pending_openai",
    });
    const response = await fixture.request("/run", {
      method: "POST",
      headers: fixture.createReviewerSession("a"),
      body: { ids: ["target"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 1, active: 1 });
    const points = fixture.authorPoints();
    expect(Number(points)).toBeGreaterThan(20);
    const notifications = fixture.notificationMessages();
    expect(notifications).toHaveLength(1);
    await remove(kind);
    const ack = vi.fn();
    const retry = vi.fn();
    await runAutoModerationQueueBatch(fixture.env, {
      messages: [
        {
          body: {
            type: "moderation",
            submissionId: "target",
            snapshotId: "snapshot-target",
            source: "upload",
            queuedAt: "old",
          },
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<LegacyAutoModerationMsg>);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(fixture.authorPoints()).toBe(points);
    expect(fixture.notificationMessages()).toEqual(notifications);
    expect(
      fixture.database.sqlite.prepare("SELECT count(*) n FROM ugc_snapshots_review_audit").get(),
    ).toEqual({ n: 1 });
  });
}
