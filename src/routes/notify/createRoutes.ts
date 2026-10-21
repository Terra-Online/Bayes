import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import {
  decodeNotificationCursor,
  getNotificationUnreadCounts,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
  serializeNotificationItem,
  type NotificationCategory,
} from "@/repositories/notifications";
import { listQuerySchema, readManySchema } from "@/routes/schema/notify";
import type { AppEnv } from "@/types/app";

import { proxyNotificationLive } from "./liveUpgrade";

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function addCategoryRoutes(app: Hono<AppEnv>, category: NotificationCategory): void {
  app.get(`/${category}/messages`, requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser")!;
    const parsed = listQuerySchema.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
      unreadOnly: c.req.query("unreadOnly"),
    });
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid notification query.",
        parsed.error.flatten(),
      );
    }

    const [result, unread] = await Promise.all([
      listNotifications(c.env.DB, {
        userId: user.uid,
        category,
        limit: parsed.data.limit ?? 20,
        cursor: decodeNotificationCursor(parsed.data.cursor),
        unreadOnly: parsed.data.unreadOnly === "1",
      }),
      getNotificationUnreadCounts(c.env.DB, user.uid),
    ]);
    return noStore(
      c.json({
        items: result.items.map((item) => serializeNotificationItem(item)),
        nextCursor: result.nextCursor,
        unread,
      }),
    );
  });

  app.patch(`/${category}/messages/:id/read`, requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser")!;
    const notificationId = c.req.param("id")?.trim();
    if (!notificationId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Notification id is required.");
    }
    const changed = await markNotificationRead(c.env.DB, {
      userId: user.uid,
      category,
      id: notificationId,
    });
    const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
    return noStore(c.json({ ok: true, changed, unread }));
  });

  app.post(`/${category}/messages/read`, requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser")!;
    const parsed = readManySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid notification read payload.",
        parsed.error.flatten(),
      );
    }
    const changed = await markNotificationsRead(c.env.DB, {
      userId: user.uid,
      category,
      ids: parsed.data.ids,
    });
    const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
    return noStore(c.json({ ok: true, changed, unread }));
  });

  app.post(`/${category}/read-all`, requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser")!;
    const changed = await markAllNotificationsRead(c.env.DB, {
      userId: user.uid,
      category,
    });
    const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
    return noStore(c.json({ ok: true, changed, unread }));
  });
}

export function createRoutes() {
  const app = new Hono<AppEnv>();

  addCategoryRoutes(app, "system");
  addCategoryRoutes(app, "community");

  app.get("/unread-count", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser")!;
    const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
    return noStore(c.json({ unread }));
  });

  app.get("/live", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser")!;
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(
        426,
        "WEBSOCKET_REQUIRED",
        "Notification live endpoint requires a WebSocket upgrade.",
      );
    }

    return proxyNotificationLive(
      c.env,
      c.req.raw,
      user.uid,
      c.req.query("clientId")?.trim() || crypto.randomUUID(),
    );
  });

  return app;
}
