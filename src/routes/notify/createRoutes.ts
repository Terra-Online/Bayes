import { Hono } from "hono";
import { z } from "zod";

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
import {
  operation,
  sessionSecurity,
  jsonResponse,
  apiErrorSchema,
} from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/notify";
import { listQuerySchema, readManySchema } from "@/routes/schema/notify";
import { publishNotificationRead } from "@/services/notify/read";
import type { AppEnv } from "@/types/app";

import { proxyNotificationLive } from "./liveUpgrade";

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function addCategoryRoutes(app: Hono<AppEnv>, category: NotificationCategory): void {
  app
    .get(
      `/${category}/messages`,
      operation(`list${category}Notifications`, "Notifications", "List category notifications", {
        errors: [409, 429, 503],
        security: sessionSecurity,
        query: listQuerySchema,
        response: docs.notificationListResponseSchema,
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
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
          } satisfies z.output<typeof docs.notificationListResponseSchema>),
        );
      },
    )
    .patch(
      `/${category}/messages/:id/read`,
      operation(`read${category}Notification`, "Notifications", "Mark one notification read", {
        errors: [409, 429, 503],
        security: sessionSecurity,
        response: docs.notificationReadOneResponseSchema,
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const notificationId = c.req.param("id")?.trim();
        if (!notificationId) {
          throw new ApiError(422, "VALIDATION_ERROR", "Notification id is required.");
        }
        const readAt = new Date().toISOString();
        const changed = await markNotificationRead(c.env.DB, {
          userId: user.uid,
          category,
          readAt,
          id: notificationId,
        });
        if (changed) {
          c.executionCtx.waitUntil(
            publishNotificationRead(c.env, user.uid, { category, ids: [notificationId], readAt }),
          );
        }
        const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
        return noStore(
          c.json({ ok: true, changed, unread } satisfies z.output<
            typeof docs.notificationReadOneResponseSchema
          >),
        );
      },
    )
    .post(
      `/${category}/messages/read`,
      operation(`read${category}Notifications`, "Notifications", "Mark notifications read", {
        errors: [409, 429, 503],
        security: sessionSecurity,
        body: readManySchema,
        response: docs.notificationReadResponseSchema,
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const parsed = readManySchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid notification read payload.",
            parsed.error.flatten(),
          );
        }
        const ids = [...new Set(parsed.data.ids.map((id) => id.trim()).filter(Boolean))];
        const readAt = new Date().toISOString();
        const changed = await markNotificationsRead(c.env.DB, {
          userId: user.uid,
          category,
          readAt,
          ids,
        });
        if (changed) {
          c.executionCtx.waitUntil(
            publishNotificationRead(c.env, user.uid, { category, ids, readAt }),
          );
        }
        const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
        return noStore(
          c.json({ ok: true, changed, unread } satisfies z.output<
            typeof docs.notificationReadResponseSchema
          >),
        );
      },
    )
    .post(
      `/${category}/read-all`,
      operation(`readAll${category}Notifications`, "Notifications", "Mark the category read", {
        errors: [409, 429, 503],
        security: sessionSecurity,
        response: docs.notificationReadResponseSchema,
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const readAt = new Date().toISOString();
        const changed = await markAllNotificationsRead(c.env.DB, {
          userId: user.uid,
          category,
          readAt,
        });
        if (changed) {
          c.executionCtx.waitUntil(
            publishNotificationRead(c.env, user.uid, { category, ids: null, readAt }),
          );
        }
        const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
        return noStore(
          c.json({ ok: true, changed, unread } satisfies z.output<
            typeof docs.notificationReadResponseSchema
          >),
        );
      },
    );
}

export function createRoutes() {
  const app = new Hono<AppEnv>();

  addCategoryRoutes(app, "system");
  addCategoryRoutes(app, "community");

  return app
    .get(
      "/unread-count",
      operation("getUnreadCounts", "Notifications", "Read notification unread counts", {
        errors: [429, 503],
        security: sessionSecurity,
        response: docs.unreadResponseSchema,
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
        return noStore(c.json({ unread } satisfies z.output<typeof docs.unreadResponseSchema>));
      },
    )
    .get(
      "/live",
      operation("connectNotificationLive", "Notifications", "Connect to live notifications", {
        errors: [429, 503],
        security: sessionSecurity,
        query: z.object({ clientId: z.string().optional() }),
        description:
          "Upgrade: websocket required. The Worker handles upgrades before Hono. See the client integration guide for frames, heartbeat, and reconnect behavior.",
        responses: {
          101: { description: "WebSocket connection established" },
          426: jsonResponse(apiErrorSchema, "WebSocket upgrade required"),
        },
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
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
      },
    );
}
