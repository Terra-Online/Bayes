import { Hono } from "hono";
import { expect, it, vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { getNotificationById } from "@/repositories/notifications";
import { createRoutes } from "@/routes/notify/createRoutes";
import { handleNotificationLiveUpgrade } from "@/routes/notify/liveUpgrade";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser } from "@/test/fixtures/auth";
import { insertNotification } from "@/test/fixtures/notifications";
import type { AppEnv } from "@/types/app";

// Only the platform class import is substituted in Node. The publisher,
// notification hydration, inbox HTTP route and authentication all execute normally.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { publishNotificationsCreated } from "./live";

it("rate-limits an authenticated live upgrade before opening recipient sockets", async () => {
  const database = createTestDatabase();
  try {
    const owner = insertAuthenticatedUser(database.sqlite, { uid: "owner" });
    const mocks = createMockBindings({ DB: database.db });
    mocks.authRateLimit.limit.mockResolvedValue({ success: false });
    const response = await handleNotificationLiveUpgrade(
      new Request("http://localhost/notify/v1/live", {
        headers: { ...owner.headers, upgrade: "websocket" },
      }),
      mocks.bindings,
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.json()).toMatchObject({
      code: "RATE_LIMITED",
      requestId: expect.any(String),
    });
    expect(mocks.notificationObjects.get).not.toHaveBeenCalled();
    expect(database.sqlite.prepare("SELECT * FROM notifications").all()).toEqual([]);
  } finally {
    database.close();
  }
});

it("retains a recoverable inbox after failed fanout, continues delivery, and permits retry", async () => {
  const database = createTestDatabase();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const owner = insertAuthenticatedUser(database.sqlite, { uid: "owner" });
    const neighbor = insertAuthenticatedUser(database.sqlite, { uid: "neighbor" });
    for (const id of ["first", "second"]) {
      insertNotification(database.sqlite, { id, recipientUserId: "owner" });
    }
    insertNotification(database.sqlite, { id: "private-neighbor", recipientUserId: "neighbor" });
    const before = database.sqlite.prepare("SELECT * FROM notifications ORDER BY id").all();
    const mocks = createMockBindings({ DB: database.db });
    mocks.authRateLimit.limit.mockResolvedValue({ success: true });
    const id: DurableObjectId = {
      name: "owner",
      toString: () => "owner-object",
      equals: (other) => other === id,
    };
    const fanout = vi
      .fn<DurableObjectStub["fetch"]>(() => {
        throw new Error("Unconfigured fanout");
      })
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, delivered: 1 }))
      .mockResolvedValueOnce(Response.json({ ok: true, delivered: 1 }));
    const stub: DurableObjectStub = {
      id,
      name: "owner",
      fetch: fanout,
      connect: vi.fn<DurableObjectStub["connect"]>(() => {
        throw new Error("Unconfigured DO connect");
      }),
    };
    mocks.notificationObjects.idFromName.mockImplementation((uid) => {
      expect(uid).toBe("owner");
      return id;
    });
    mocks.notificationObjects.get.mockReturnValue(stub);
    const first = (await getNotificationById(database.db, "first"))!;
    const second = (await getNotificationById(database.db, "second"))!;
    await publishNotificationsCreated(mocks.bindings, [first, second]);
    const app = new Hono<AppEnv>().onError(onAppError).route("/notify/v1", createRoutes());
    for (const [identity, ids] of [
      [owner, ["first", "second"]],
      [neighbor, ["private-neighbor"]],
    ] as const) {
      const response = await app.request(
        "http://localhost/notify/v1/system/messages",
        { headers: identity.headers },
        mocks.bindings,
      );
      expect(response.status).toBe(200);
      const inbox = (await response.json()) as {
        items: { id: string }[];
        unread: { total: number };
      };
      expect(inbox.items.map((item) => item.id).sort()).toEqual([...ids].sort());
      expect(inbox.unread.total).toBe(ids.length);
    }
    await publishNotificationsCreated(mocks.bindings, [first]);
    const deliveredIds = await Promise.all(
      fanout.mock.calls.map(async ([input, init]) => {
        const request = new Request(input, init);
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-oem-notify-user")).toBe("owner");
        const envelope = (await request.json()) as {
          event: string;
          notification: { id: string };
          unread: { total: number };
        };
        expect(envelope.event).toBe("notification.upserted");
        expect(envelope.unread.total).toBe(2);
        return envelope.notification.id;
      }),
    );
    // The failed first delivery must not block the second, and retry must target
    // only the requested notification without duplicating the rest of the batch.
    expect(deliveredIds).toEqual(["first", "second", "first"]);
    expect(database.sqlite.prepare("SELECT * FROM notifications ORDER BY id").all()).toEqual(
      before,
    );
  } finally {
    database.close();
    errorLog.mockRestore();
  }
});
