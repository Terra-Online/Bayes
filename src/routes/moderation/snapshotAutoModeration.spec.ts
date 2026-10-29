import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  runAutoModerationQueueBatch,
  type LegacyAutoModerationMsg,
} from "@/queues/runtime/autoModeration";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertImageSnapshot } from "@/test/fixtures/imageSnapshots";
import { createModerationTestFixture } from "@/test/fixtures/moderation";

// The HTTP/auth/service/repository path stays real. Only external services and
// the Workers runtime import are replaced at their boundaries.
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

import {
  getReviewTarget,
  reviewSnapshot,
  type ReviewCommand,
} from "@/repositories/submission/reviewSnapshot";
import type { SnapshotReviewStatus } from "@/repositories/submission/snapshotReads";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";

let fixture: ReturnType<typeof createModerationTestFixture>;
beforeEach(() => {
  redisCounts.clear();
  fixture = createModerationTestFixture();
  importCurrentSubmissions(fixture.database);
  fixture.env.OPENAI_API_KEY = "test-key";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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

function seed(
  id: string,
  status: SnapshotReviewStatus = "pending_openai",
  options: { kind?: "image" | "comment"; parentId?: string; userId?: string } = {},
): void {
  const { kind = "comment", parentId, userId = "author" } = options;
  if (kind === "image") {
    insertImageSnapshot(fixture.database.sqlite, { id, userId, reviewStatus: status });
  } else {
    insertCommentSnapshot(fixture.database.sqlite, { id, userId, parentId, reviewStatus: status });
  }
}
function edit(id: string): void {
  fixture.database.sqlite
    .prepare(`INSERT INTO ugc_snapshots
    (id,submission_id,kind,revision,content,review_status,creator_user_id)
    SELECT 'edit-' || id,id,kind,revision+1,'Corrected directions','pending_openai',user_id FROM ugc_submissions WHERE id=?`)
    .run(id);
  fixture.database.sqlite
    .prepare("UPDATE ugc_submissions SET revision=revision+1 WHERE id=?")
    .run(id);
}
function status(id: string): unknown {
  return fixture.database.sqlite
    .prepare("SELECT review_status FROM ugc_snapshots WHERE id=?")
    .get(id)?.review_status;
}
function audits(): unknown[] {
  return fixture.database.sqlite
    .prepare(
      "SELECT snapshot_id,from_status,to_status,source,admin_user_id FROM ugc_snapshots_review_audit ORDER BY rowid",
    )
    .all();
}
async function run(ids: string[]): Promise<Response> {
  return fixture.request("/run", {
    method: "POST",
    headers: fixture.createReviewerSession("a"),
    body: { ids },
  });
}
async function consume(snapshotId: string | undefined, submissionId = "photo") {
  const ack = vi.fn();
  const retry = vi.fn();
  await runAutoModerationQueueBatch(fixture.env, {
    messages: [
      {
        body: { type: "moderation", submissionId, snapshotId, source: "upload", queuedAt: "old" },
        ack,
        retry,
      },
    ],
  } as unknown as MessageBatch<LegacyAutoModerationMsg>);
  return { ack, retry };
}
async function command(
  id: string,
  decision: ReviewCommand["decision"],
  expectedReviewStatus: SnapshotReviewStatus = "pending_openai",
) {
  const target = await getReviewTarget(fixture.database.db, id);
  if (!target) {
    throw new Error("Missing test review target");
  }
  return reviewSnapshot(fixture.database.db, {
    target,
    decision,
    expectedReviewStatus,
    source: "admin",
    adminUserId: "reviewer",
    auditId: crypto.randomUUID(),
  });
}

it("approves the selected immutable snapshot through HTTP and only rewards it once", async () => {
  seed("comment");
  const response = await run(["comment", "comment", "missing"]);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ processed: 1, active: 1 });
  expect(fixture.authorPoints()).toBe(22);
  expect(audits()).toEqual([
    {
      snapshot_id: "snapshot-comment",
      from_status: "pending_openai",
      to_status: "approved",
      source: "ai",
      admin_user_id: null,
    },
  ]);
  expect(fixture.notificationMessages()).toHaveLength(1);
  expect(fixture.messages.translation).toHaveLength(1);
  expect(fixture.messages.live).toHaveLength(1);
  expect(await (await run(["comment"])).json()).toMatchObject({ processed: 0 });
  expect(fixture.authorPoints()).toBe(22);
  expect(fetch).toHaveBeenCalledOnce();
});

it("acknowledges old unversioned work without binding it to the current snapshot, then backfills the retained exact ID", async () => {
  seed("photo", "pending_openai", { kind: "image" });
  const { ack, retry } = await consume(undefined);
  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith(
    "skipping unversioned moderation message",
    expect.objectContaining({ submissionId: "photo" }),
  );
  expect(status("snapshot-photo")).toBe("pending_openai");
  expect(audits()).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  const response = await fixture.request("/run-once", {
    method: "POST",
    headers: fixture.createReviewerSession("a"),
  });
  expect(response.status).toBe(200);
  expect(fixture.messages.moderation).toEqual([
    expect.objectContaining({
      submissionId: "photo",
      snapshotId: "snapshot-photo",
      source: "scheduled_backfill",
    }),
  ]);
  fixture.env.UGC_BUCKET = { get: async () => null } as unknown as R2Bucket;
  const delivered = await consume("snapshot-photo");
  expect(delivered.ack).toHaveBeenCalledOnce();
  expect(status("snapshot-photo")).toBe("approved");
  expect(fixture.authorPoints()).toBe(26);
  await consume("snapshot-photo");
  await consume("wrong-id");
  expect(audits()).toHaveLength(1);
  expect(fixture.authorPoints()).toBe(26);
});

it.each(["notification", "points"] as const)(
  "preserves the independent %s failure and retry boundary through HTTP",
  async (failure) => {
    seed("waiting");
    fixture.database.sqlite.exec(
      failure === "notification"
        ? `CREATE TEMP TRIGGER fail_write BEFORE INSERT ON notification_messages BEGIN SELECT RAISE(ABORT,'notification failed'); END`
        : `CREATE TEMP TRIGGER fail_write BEFORE UPDATE OF points ON users BEGIN SELECT RAISE(ABORT,'points failed'); END`,
    );
    expect((await run(["waiting"])).status).toBe(500);
    expect(status("snapshot-waiting")).toBe(
      failure === "notification" ? "pending_openai" : "approved",
    );
    expect(audits()).toHaveLength(failure === "notification" ? 0 : 1);
    expect(fixture.notificationMessages()).toHaveLength(failure === "notification" ? 0 : 1);
    expect(fixture.messages.translation).toHaveLength(failure === "notification" ? 0 : 1);
    expect(fixture.authorPoints()).toBe(20);
    fixture.database.sqlite.exec("DROP TRIGGER fail_write");
    expect((await run(["waiting"])).status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(fixture.notificationMessages()).toHaveLength(1);
    expect(fixture.authorPoints()).toBe(failure === "notification" ? 22 : 20);
  },
);

it.each(["takeover", "author deletion", "admin disable"])(
  "ignores an AI result after in-flight %s",
  async (race) => {
    seed("comment");
    insertUser(fixture.database.sqlite, { uid: "reviewer", uid_number: 300, role: "a" });
    vi.mocked(fetch).mockImplementation(async () => {
      if (race === "takeover") {
        expect(await command("comment", "pending_audit")).toMatchObject({
          outcome: "committed",
          firstApproval: false,
        });
      } else {
        fixture.database.sqlite
          .prepare(
            `UPDATE ugc_submissions SET ${race === "author deletion" ? "author_deleted_at" : "admin_deleted_at"}='deleted' WHERE id='comment'`,
          )
          .run();
      }
      return Response.json({ results: [{ flagged: false }] });
    });
    expect(await (await run(["comment"])).json()).toMatchObject({ processed: 0 });
    expect(audits()).toEqual(
      race === "takeover"
        ? [
            {
              snapshot_id: "snapshot-comment",
              from_status: "pending_openai",
              to_status: "pending_audit",
              source: "admin",
              admin_user_id: "reviewer",
            },
          ]
        : [],
    );
    expect(status("snapshot-comment")).toBe(
      race === "takeover" ? "pending_audit" : "pending_openai",
    );
    expect(fixture.authorPoints()).toBe(20);
    expect(fixture.messages.webhook).toEqual([]);
    expect(fixture.notificationMessages()).toHaveLength(race === "takeover" ? 1 : 0);
  },
);

it("clears flags only on public A to B replacement and never on a duplicate approval", async () => {
  seed("comment", "approved");
  edit("comment");
  insertUser(fixture.database.sqlite, { uid: "flagger", uid_number: 400 });
  fixture.database.sqlite.exec(
    "INSERT INTO ugc_submission_flags (submission_id,user_id,active) VALUES ('comment','flagger',1)",
  );
  expect(
    fixture.database.sqlite.prepare("SELECT snapshot_id FROM ugc_public_submissions").get(),
  ).toEqual({ snapshot_id: "snapshot-comment" });
  expect((await run(["comment"])).status).toBe(200);
  expect(fixture.database.sqlite.prepare("SELECT active FROM ugc_submission_flags").get()).toEqual({
    active: 0,
  });
  expect(
    fixture.database.sqlite.prepare("SELECT snapshot_id FROM ugc_public_submissions").get(),
  ).toEqual({ snapshot_id: "edit-comment" });
  expect(fixture.authorPoints()).toBe(20);
  expect(redisCounts.size).toBe(0);
  fixture.database.sqlite.exec("UPDATE ugc_submission_flags SET active=1");
  await consume("edit-comment", "comment");
  expect(fixture.database.sqlite.prepare("SELECT active FROM ugc_submission_flags").get()).toEqual({
    active: 1,
  });
  expect(audits()).toHaveLength(1);
  expect(fixture.notificationMessages()).toHaveLength(1);
});

it("retains flags when admin rejection removes the previous public version", async () => {
  seed("comment", "approved");
  edit("comment");
  insertUser(fixture.database.sqlite, { uid: "reviewer", uid_number: 300, role: "p" });
  fixture.database.sqlite.exec(
    "INSERT INTO ugc_submission_flags (submission_id,user_id,active) VALUES ('comment','reviewer',1)",
  );
  expect(await command("comment", "rejected")).toMatchObject({
    outcome: "committed",
    publicReplaced: false,
    firstApproval: false,
    notifications: [],
  });
  expect(fixture.database.sqlite.prepare("SELECT * FROM ugc_public_submissions").all()).toEqual([]);
  expect(fixture.database.sqlite.prepare("SELECT active FROM ugc_submission_flags").get()).toEqual({
    active: 1,
  });
});

it("aggregates first replies and author approvals, dedupes reply edits, and preserves unread counters", async () => {
  insertUser(fixture.database.sqlite, { uid: "parent-author", uid_number: 500 });
  seed("parent", "approved", { userId: "parent-author" });
  seed("reply1", "pending_openai", { parentId: "parent" });
  seed("reply2", "pending_openai", { parentId: "parent" });
  expect((await run(["reply1", "reply2"])).status).toBe(200);
  expect(
    fixture.database.sqlite
      .prepare("SELECT type,message_count FROM notifications ORDER BY type")
      .all(),
  ).toEqual([
    { type: "community.comment.reply", message_count: 2 },
    { type: "system.submission.approved", message_count: 2 },
  ]);
  // Existing daily backoff gives the second approval one point.
  expect(fixture.authorPoints()).toBe(23);
  edit("reply1");
  await run(["reply1"]);
  expect(
    fixture.database.sqlite
      .prepare("SELECT type,message_count FROM notifications ORDER BY type")
      .all(),
  ).toEqual([
    { type: "community.comment.reply", message_count: 2 },
    { type: "system.submission.approved", message_count: 3 },
  ]);
  expect(
    fixture.database.sqlite
      .prepare(
        "SELECT user_id,system_unread,community_unread FROM notification_counters ORDER BY user_id",
      )
      .all(),
  ).toEqual([
    { user_id: "author", system_unread: 1, community_unread: 0 },
    { user_id: "parent-author", system_unread: 0, community_unread: 1 },
  ]);
  expect(fixture.authorPoints()).toBe(23);
});

it.each(["skip", "missing credentials", "flagged", "no decision", "outage", "timeout"])(
  "sends %s to manual without a rejection or reward",
  async (reason) => {
    seed("comment");
    if (reason === "skip") {
      fixture.env.SKIP_AI_MODERATION = "true";
    }
    if (reason === "missing credentials") {
      fixture.env.OPENAI_API_KEY = undefined;
    }
    vi.mocked(fetch).mockImplementation(async () => {
      if (reason === "timeout") {
        throw new DOMException("Aborted", "AbortError");
      }
      if (reason === "outage") {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({ results: reason === "no decision" ? [] : [{ flagged: true }] });
    });
    expect(await (await run(["comment"])).json()).toMatchObject({
      processed: 1,
      pendingAudit: 1,
      active: 0,
    });
    expect(status("snapshot-comment")).toBe("pending_audit");
    expect(audits()).toEqual([
      {
        snapshot_id: "snapshot-comment",
        from_status: "pending_openai",
        to_status: "pending_audit",
        source: "ai",
        admin_user_id: null,
      },
    ]);
    expect(fixture.authorPoints()).toBe(20);
    expect(fixture.notificationMessages()).toHaveLength(1);
  },
);

it("commits only one of two overlapping queue reviews of the same snapshot", async () => {
  seed("photo");
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let calls = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    calls += 1;
    if (calls === 1) {
      announce?.();
      await waiting;
    }
    return Response.json({ results: [{ flagged: false }] });
  });
  const first = consume("snapshot-photo");
  await started;
  const second = await consume("snapshot-photo");
  release?.();
  const late = await first;
  expect(second.ack).toHaveBeenCalledOnce();
  expect(late.ack).toHaveBeenCalledOnce();
  expect(audits()).toHaveLength(1);
  expect(fixture.notificationMessages()).toHaveLength(1);
  expect(fixture.authorPoints()).toBe(22);
  expect(fixture.messages.webhook).toHaveLength(1);
});

it("ignores terminal, deleted, disabled and nonfrontier queue targets before calling AI", async () => {
  seed("approved", "approved");
  seed("manual", "pending_audit");
  seed("rejected", "rejected");
  seed("unknown", "unknown");
  seed("deleted");
  seed("disabled");
  seed("old");
  fixture.database.sqlite
    .exec(`UPDATE ugc_submissions SET author_deleted_at='deleted' WHERE id='deleted';
    UPDATE ugc_submissions SET admin_deleted_at='disabled' WHERE id='disabled';
    INSERT INTO ugc_snapshots(id,submission_id,kind,revision,content,review_status,creator_user_id)
    VALUES ('new','old','comment',2,'New content','approved','author');
    UPDATE ugc_submissions SET revision=2 WHERE id='old';`);
  for (const id of ["approved", "manual", "rejected", "unknown", "deleted", "disabled", "old"]) {
    const result = await consume(`snapshot-${id}`, id);
    expect(result.ack).toHaveBeenCalledOnce();
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(audits()).toEqual([]);
  expect(fixture.notificationMessages()).toEqual([]);
  expect(fixture.authorPoints()).toBe(20);
});

it("retries queue database failures but does not replay committed reviews after points failure", async () => {
  seed("photo");
  fixture.database.sqlite.exec(
    `CREATE TEMP TRIGGER fail_points BEFORE UPDATE OF points ON users BEGIN SELECT RAISE(ABORT,'points failed'); END`,
  );
  const failed = await consume("snapshot-photo");
  expect(failed.retry).toHaveBeenCalledOnce();
  expect(failed.ack).not.toHaveBeenCalled();
  expect(status("snapshot-photo")).toBe("approved");
  expect(fixture.authorPoints()).toBe(20);
  fixture.database.sqlite.exec("DROP TRIGGER fail_points");
  const retry = await consume("snapshot-photo");
  expect(retry.ack).toHaveBeenCalledOnce();
  expect(audits()).toHaveLength(1);
  expect(fixture.authorPoints()).toBe(20);
  expect(fetch).toHaveBeenCalledOnce();
});

it("recovers eligible pending images and comments and retains the queue-send and marker-failure policies", async () => {
  for (const id of ["first", "expired", "fresh", "deleted", "disabled"]) {
    seed(id, "pending_openai", { kind: "image" });
  }
  seed("comment");
  seed("manual", "pending_audit", { kind: "image" });
  fixture.database.sqlite
    .prepare("UPDATE ugc_snapshots SET moderation_queued_at=? WHERE id='snapshot-fresh'")
    .run(new Date().toISOString());
  fixture.database.sqlite
    .exec(`UPDATE ugc_snapshots SET moderation_queued_at='2000-01-01T00:00:00Z' WHERE id='snapshot-expired';
    UPDATE ugc_submissions SET author_deleted_at='deleted' WHERE id='deleted';
    UPDATE ugc_submissions SET admin_deleted_at='disabled' WHERE id='disabled';`);
  const send = fixture.env.OEM_MODERATION_Q.send;
  fixture.env.OEM_MODERATION_Q.send = async () => {
    throw new Error("Queue unavailable");
  };
  const options = {
    method: "POST",
    headers: fixture.createReviewerSession("a"),
    body: { limit: 10 },
  };
  expect((await fixture.request("/run", options)).status).toBe(500);
  expect(fixture.messages.moderation).toEqual([]);
  fixture.env.OEM_MODERATION_Q.send = send;
  fixture.database.sqlite.exec(
    `CREATE TEMP TRIGGER fail_marker BEFORE UPDATE OF moderation_queued_at ON ugc_snapshots BEGIN SELECT RAISE(ABORT,'marker failed'); END`,
  );
  expect(await (await fixture.request("/run", options)).json()).toMatchObject({ enqueued: 3 });
  expect(fixture.messages.moderation).toEqual([
    expect.objectContaining({ submissionId: "comment", snapshotId: "snapshot-comment" }),
    expect.objectContaining({ submissionId: "expired", snapshotId: "snapshot-expired" }),
    expect.objectContaining({ submissionId: "first", snapshotId: "snapshot-first" }),
  ]);
  fixture.database.sqlite.exec("DROP TRIGGER fail_marker");
  expect(await (await fixture.request("/run", options)).json()).toMatchObject({ enqueued: 3 });
  expect(await (await fixture.request("/run", options)).json()).toMatchObject({ enqueued: 0 });
  expect(audits()).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["stored image", "public fallback"])(
  "moderates the exact %s file and warms it after commit",
  async (source) => {
    seed("photo", "pending_openai", { kind: "image" });
    fixture.env.UGC_BUCKET = {
      get: async () =>
        source === "stored image"
          ? {
              httpMetadata: { contentType: "image/png" },
              arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            }
          : null,
    } as unknown as R2Bucket;
    const aiInputs: unknown[] = [];
    const warmed: string[] = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url) === "https://api.openai.com/v1/moderations") {
        aiInputs.push(JSON.parse(String(init?.body)).input);
        expect(new Headers(init?.headers).get("X-Client-Request-Id")).toBe(
          "moderation:photo:snapshot-photo",
        );
        return Response.json({ results: [{ flagged: false }] });
      }
      warmed.push(String(url));
      expect(status("snapshot-photo")).toBe("approved");
      return new Response("image");
    });
    expect((await run(["photo"])).status).toBe(200);
    expect(aiInputs).toEqual([
      [
        {
          type: "image_url",
          image_url: {
            url:
              source === "stored image"
                ? "data:image/png;base64,AQID"
                : "https://assets.example.test/images/photo.webp",
          },
        },
      ],
    ]);
    expect(warmed).toEqual(["https://assets.example.test/images/photo.webp"]);
    expect(fixture.authorPoints()).toBe(26);
  },
);

it("reopens read author aggregation on an edit and starts a new group after the window expires", async () => {
  seed("comment");
  await run(["comment"]);
  fixture.database.sqlite.exec("UPDATE notifications SET read_at='read'");
  edit("comment");
  await run(["comment"]);
  expect(
    fixture.database.sqlite.prepare("SELECT read_at,message_count FROM notifications").all(),
  ).toEqual([{ read_at: null, message_count: 2 }]);
  expect(
    fixture.database.sqlite
      .prepare("SELECT system_unread FROM notification_counters WHERE user_id='author'")
      .get(),
  ).toEqual({ system_unread: 1 });
  fixture.database.sqlite.exec("UPDATE notifications SET window_expires_at='2000-01-01T00:00:00Z'");
  seed("other");
  await run(["other"]);
  expect(
    fixture.database.sqlite.prepare("SELECT message_count FROM notifications ORDER BY rowid").all(),
  ).toEqual([{ message_count: 2 }, { message_count: 1 }]);
  expect(
    fixture.database.sqlite
      .prepare("SELECT system_unread FROM notification_counters WHERE user_id='author'")
      .get(),
  ).toEqual({ system_unread: 2 });
});

it("keeps committed review effects when author deletion happens afterwards", async () => {
  seed("comment");
  expect((await run(["comment"])).status).toBe(200);
  fixture.database.sqlite.exec(
    "UPDATE ugc_submissions SET author_deleted_at='deleted' WHERE id='comment'",
  );
  await consume("snapshot-comment", "comment");
  expect(fixture.database.sqlite.prepare("SELECT * FROM ugc_public_submissions").all()).toEqual([]);
  expect(audits()).toHaveLength(1);
  expect(fixture.notificationMessages()).toHaveLength(1);
  expect(fixture.authorPoints()).toBe(22);
  expect(fixture.messages.webhook).toHaveLength(1);
});
