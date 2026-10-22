import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import type { SerializedNotificationItem } from "@/repositories/notifications";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertNotification } from "@/test/fixtures/notifications";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let sessions: Map<string, ReturnType<typeof insertSession>>;

beforeEach(() => {
  database = createTestDatabase();
  sessions = new Map();
  for (const uid of ["alice", "bob", "empty"]) {
    insertUser(database.sqlite, { uid });
    insertAuthUser(database.sqlite, { id: uid });
    sessions.set(uid, insertSession(database.sqlite, { userId: uid }));
  }
  for (const [id, recipientUserId, category, createdAt] of [
    ["approval-a", "alice", "system", "2026-09-01T10:00:00.000Z"],
    ["approval-b", "alice", "system", "2026-09-02T10:00:00.000Z"],
    ["approval-c", "alice", "system", "2026-09-02T10:00:00.000Z"],
    ["reply", "alice", "community", "2026-09-03T10:00:00.000Z"],
    ["bob-approval", "bob", "system", "2026-09-04T10:00:00.000Z"],
    ["bob-reply", "bob", "community", "2026-09-04T10:00:00.000Z"],
  ] as const) {
    insertNotification(database.sqlite, {
      id,
      recipientUserId,
      category,
      type: category === "community" ? "community.comment.reply" : "system.submission.approved",
      createdAt,
    });
  }
});

afterEach(() => {
  database.close();
  vi.useRealTimers();
});

function request(path: string, uid: string | undefined = "alice", init: RequestInit = {}) {
  const app = new Hono<AppEnv>();
  app.onError(onAppError);
  app.route("/notify/v1", createRoutes());
  const headers = new Headers(init.headers);
  if (uid) {
    headers.set("authorization", sessions.get(uid)!.headers.authorization);
  }
  return app.request(`http://localhost/notify/v1${path}`, { ...init, headers }, {
    DB: database.db,
    ...testAuthConfig,
    OEM_AUTH_RATE_LIMIT: { limit: async () => ({ success: true }) },
  } as unknown as AppEnv["Bindings"]);
}

type InboxPage = {
  items: SerializedNotificationItem[];
  nextCursor: string | null;
  unread: { system: number; community: number; total: number };
};

async function inbox(path = "/system/messages", uid = "alice"): Promise<InboxPage> {
  const response = await request(path, uid);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response.json();
}

describe("notification inbox HTTP", () => {
  it("requires a session for notification reads and every read-state operation", async () => {
    for (const category of ["system", "community"]) {
      for (const [path, method] of [
        [`/${category}/messages`, "GET"],
        [`/${category}/messages/approval-a/read`, "PATCH"],
        [`/${category}/messages/read`, "POST"],
        [`/${category}/read-all`, "POST"],
      ]) {
        const response = await request(path, "", { method });
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
      }
    }
    expect((await request("/unread-count", "")).status).toBe(401);
    expect((await inbox()).unread).toEqual({ system: 3, community: 1, total: 4 });
  });

  it("returns empty private inboxes and zero counts for a recipient with no notifications", async () => {
    expect(await inbox("/system/messages", "empty")).toEqual({
      items: [],
      nextCursor: null,
      unread: { system: 0, community: 0, total: 0 },
    });
    expect(await inbox("/community/messages?unreadOnly=1", "empty")).toEqual({
      items: [],
      nextCursor: null,
      unread: { system: 0, community: 0, total: 0 },
    });
    const response = await request("/unread-count", "empty");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ unread: { system: 0, community: 0, total: 0 } });
  });

  it("rejects invalid inbox filters and read batches without changing unread state", async () => {
    for (const category of ["system", "community"]) {
      for (const query of ["limit=0", "unreadOnly=yes"]) {
        const response = await request(`/${category}/messages?${query}`);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      }
      const blankId = await request(`/${category}/messages/%20/read`, "alice", { method: "PATCH" });
      expect(blankId.status).toBe(422);
      expect(await blankId.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      for (const body of ["{", JSON.stringify({ ids: [] })]) {
        const response = await request(`/${category}/messages/read`, "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
    expect((await inbox()).unread).toEqual({ system: 3, community: 1, total: 4 });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS readCount FROM notifications WHERE read_at IS NOT NULL")
        .get(),
    ).toEqual({ readCount: 0 });
  });

  it("paginates the recipient's category without losing notifications sharing a timestamp", async () => {
    const first = await inbox("/system/messages?limit=1");
    expect(first.items).toEqual([
      expect.objectContaining({
        id: "approval-c",
        type: "system.submission.approved",
        readAt: null,
      }),
    ]);
    expect(first.unread).toEqual({ system: 3, community: 1, total: 4 });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await inbox(
      `/system/messages?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.items.map((item) => item.id)).toEqual(["approval-b"]);
    expect(second.nextCursor).toEqual(expect.any(String));
    const last = await inbox(
      `/system/messages?limit=1&cursor=${encodeURIComponent(second.nextCursor!)}`,
    );
    expect(last.items.map((item) => item.id)).toEqual(["approval-a"]);
    expect(last.nextCursor).toBeNull();

    expect((await inbox("/community/messages")).items.map((item) => item.id)).toEqual(["reply"]);
    expect((await inbox("/system/messages", "bob")).items.map((item) => item.id)).toEqual([
      "bob-approval",
    ]);
  });

  it("falls back to the first inbox page for malformed cursors without changing unread state", async () => {
    const before = database.sqlite.prepare("SELECT * FROM notifications ORDER BY id").all();
    const first = await inbox("/system/messages?limit=1");
    for (const cursor of ["no-separator", "%ZZ", "date|"]) {
      expect(await inbox(`/system/messages?limit=1&cursor=${encodeURIComponent(cursor)}`)).toEqual(
        first,
      );
    }
    expect(database.sqlite.prepare("SELECT * FROM notifications ORDER BY id").all()).toEqual(
      before,
    );
  });

  it("presents grouped approvals with each destination and counts the group as one unread notification", async () => {
    for (const [id, at] of [
      ["photo-one", "2026-09-05T10:00:00.000Z"],
      ["photo-two", "2026-09-05T10:00:30.000Z"],
    ]) {
      insertSubmission(database.sqlite, { id, userId: "alice", kind: "image", markerId: id });
      database.sqlite
        .prepare(`INSERT INTO notification_messages
        (id, notification_id, submission_id, marker_id, payload_json, dedupe_key, created_at)
        VALUES (?, 'approval-a', ?, ?, ?, ?, ?)`)
        .run(
          `message-${id}`,
          id,
          id,
          JSON.stringify({ kind: "image", email: "private@example.test" }),
          `message-${id}`,
          at,
        );
    }
    database.sqlite.exec(`UPDATE notifications SET message_count = 2,
      last_event_at = '2026-09-05T10:00:30.000Z' WHERE id = 'approval-a'`);
    const page = await inbox("/system/messages?limit=1");
    expect(page.unread).toEqual({ system: 3, community: 1, total: 4 });
    expect(page.items[0]).toMatchObject({
      id: "approval-a",
      type: "system.submission.approved",
      payload: { kind: "image", messageCount: 2 },
      isMultiMsg: true,
      createdAt: "2026-09-05T10:00:30.000Z",
      target: {
        submissionId: null,
        parentSubmissionId: null,
        markerId: null,
        poiHash: null,
        poiType: null,
      },
    });
    expect(
      page.items[0].messages.map((message) => ({
        id: message.id,
        target: message.target.submissionId,
        payload: message.payload,
        readAt: message.readAt,
      })),
    ).toEqual([
      { id: "message-photo-one", target: "photo-one", payload: { kind: "image" }, readAt: null },
      { id: "message-photo-two", target: "photo-two", payload: { kind: "image" }, readAt: null },
    ]);
    // Stored payloads can contain private metadata; neither the group nor its
    // expanded messages may expose it to the recipient.
    expect(JSON.stringify(page)).not.toContain("private@example.test");
    const read = await request("/system/messages/approval-a/read", "alice", { method: "PATCH" });
    expect(await read.json()).toMatchObject({ unread: { system: 2, community: 1, total: 3 } });
    const group = (await inbox("/system/messages?limit=1")).items[0];
    expect(group.readAt).toEqual(expect.any(String));
    expect(group.messages.map((message) => message.readAt)).toEqual([group.readAt, group.readAt]);
  });

  it("marks one notification read, keeps its first read time on retry, and updates unread-only reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const readAt = new Date().toISOString();
    const response = await request("/system/messages/approval-b/read", "alice", {
      method: "PATCH",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      changed: true,
      unread: { system: 2, community: 1, total: 3 },
    });
    expect(
      database.sqlite.prepare("SELECT read_at FROM notifications WHERE id = 'approval-b'").get(),
    ).toEqual({ read_at: readAt });

    vi.setSystemTime(Date.now() + 1000);
    const retry = await request("/system/messages/approval-b/read", "alice", { method: "PATCH" });
    expect(retry.status).toBe(200);
    expect((await inbox()).items.find((item) => item.id === "approval-b")?.readAt).toBe(readAt);
    const unread = await inbox("/system/messages?unreadOnly=1");
    expect(unread.items.map((item) => item.id)).toEqual(["approval-c", "approval-a"]);
    expect(unread.unread).toEqual({ system: 2, community: 1, total: 3 });
    const counts = await request("/unread-count");
    expect(counts.headers.get("cache-control")).toBe("private, no-store");
    expect(await counts.json()).toEqual({ unread: { system: 2, community: 1, total: 3 } });
  });

  it("does not mark another recipient's notification or a notification in another category", async () => {
    for (const id of ["bob-approval", "reply", "missing"]) {
      const response = await request(`/system/messages/${id}/read`, "alice", { method: "PATCH" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        changed: false,
        unread: { system: 3, community: 1, total: 4 },
      });
    }
    expect((await inbox("/community/messages")).items[0].readAt).toBeNull();
    expect((await inbox("/system/messages", "bob")).items[0].readAt).toBeNull();
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS readCount FROM notifications WHERE read_at IS NOT NULL")
        .get(),
    ).toEqual({ readCount: 0 });
  });

  it("reads a batch of owned notifications once even when IDs repeat or include unrelated messages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const readAt = new Date().toISOString();
    const blankSelection = await request("/system/messages/read", "alice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [" ", "\t"] }),
    });
    expect(blankSelection.status).toBe(200);
    expect(await blankSelection.json()).toEqual({
      ok: true,
      changed: 0,
      unread: { system: 3, community: 1, total: 4 },
    });
    const batchReadRequest: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: ["approval-a", "approval-b", "approval-a", "bob-approval", "reply", "missing"],
      }),
    };
    const response = await request("/system/messages/read", "alice", batchReadRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      changed: 2,
      unread: { system: 1, community: 1, total: 2 },
    });
    vi.setSystemTime(Date.now() + 1000);
    const retry = await request("/system/messages/read", "alice", batchReadRequest);
    expect(retry.status).toBe(200);
    // A retry must preserve the business state, regardless of the update's matched-row count.
    expect((await inbox()).items).toEqual([
      expect.objectContaining({ id: "approval-c", readAt: null }),
      expect.objectContaining({ id: "approval-b", readAt }),
      expect.objectContaining({ id: "approval-a", readAt }),
    ]);
    expect((await inbox("/community/messages")).unread).toEqual({
      system: 1,
      community: 1,
      total: 2,
    });
    expect((await inbox("/system/messages", "bob")).unread).toEqual({
      system: 1,
      community: 1,
      total: 2,
    });
    expect(
      database.sqlite
        .prepare("SELECT id, read_at FROM notifications WHERE read_at IS NOT NULL ORDER BY id")
        .all(),
    ).toEqual([
      { id: "approval-a", read_at: readAt },
      { id: "approval-b", read_at: readAt },
    ]);
  });

  it.each([
    {
      category: "system",
      changed: 3,
      unread: { system: 0, community: 1, total: 1 },
      readIds: ["approval-a", "approval-b", "approval-c"],
    },
    {
      category: "community",
      changed: 1,
      unread: { system: 3, community: 0, total: 3 },
      readIds: ["reply"],
    },
  ])(
    "reads all $category notifications while preserving other inboxes, including on retry",
    async ({ category, changed, unread, readIds }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const readAt = new Date().toISOString();
      const response = await request(`/${category}/read-all`, "alice", { method: "POST" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ ok: true, changed, unread });
      expect((await inbox(`/${category}/messages?unreadOnly=1`)).items).toEqual([]);
      expect(
        database.sqlite
          .prepare("SELECT id FROM notifications WHERE read_at IS NOT NULL ORDER BY id")
          .all(),
      ).toEqual(readIds.map((id) => ({ id })));
      vi.setSystemTime(Date.now() + 1000);
      const retry = await request(`/${category}/read-all`, "alice", { method: "POST" });
      expect(await retry.json()).toEqual({ ok: true, changed: 0, unread });
      const retriedInbox = await inbox(`/${category}/messages`);
      expect(
        retriedInbox.items
          .map(({ id, readAt }) => ({ id, readAt }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(readIds.map((id) => ({ id, readAt })));
      expect((await inbox("/system/messages", "bob")).unread).toEqual({
        system: 1,
        community: 1,
        total: 2,
      });
    },
  );
});
