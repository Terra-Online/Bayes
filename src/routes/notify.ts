import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { hmacServiceIdentifier } from "../lib/serviceIdentity";
import { requireAuth, resolveRequestAuthUser } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import {
  decodeNotificationCursor,
  getNotificationUnreadCounts,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
  serializeNotificationItem,
  type NotificationCategory,
} from "../repositories/notifications";
import type { AppEnv, Bindings } from "../types/app";

const NOTIFICATION_LIVE_PATH = "/notify/v1/live";

const listQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  unreadOnly: z.enum(["0", "1"]).optional()
});

const readManySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(100)
});

function requireUser(c: import("hono").Context<AppEnv>) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  return user;
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function proxyNotificationLive(
  env: Bindings,
  request: Request,
  uid: string,
  clientId: string
): Promise<Response> {
  const objectId = env.OEM_NOTIFICATION_DO.idFromName(uid);
  const stub = env.OEM_NOTIFICATION_DO.get(objectId);
  const headers = new Headers(request.headers);
  headers.set("x-oem-notify-user", uid);
  headers.set("x-oem-notify-client-id", clientId);

  return stub.fetch("https://notify.internal/connect", {
    method: "GET",
    headers
  });
}

function liveUpgradeError(error: unknown, requestId: string): Response {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "INTERNAL_ERROR", "Internal server error.");
  if (apiError.status >= 500) {
    console.error("notification live upgrade failed", {
      requestId,
      code: apiError.code,
      error
    });
  }
  return new Response(JSON.stringify({
    code: apiError.code,
    message: apiError.message,
    details: apiError.details,
    requestId
  }), {
    status: apiError.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId
    }
  });
}

/**
 * Keep the WebSocket 101 response out of Hono's response reconstruction path.
 * The Cloudflare WebSocket handle is carried on the Response itself and must
 * reach the runtime unchanged.
 */
export async function handleNotificationLiveUpgrade(
  request: Request,
  env: Bindings
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    request.method !== "GET"
    || url.pathname !== NOTIFICATION_LIVE_PATH
    || request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    return null;
  }

  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const user = await resolveRequestAuthUser(env, request);
    if (user.role !== "r") {
      const requestIp = request.headers.get("cf-connecting-ip") ?? "anonymous";
      const key = await hmacServiceIdentifier(env, "cf-rate:notify-live", `ip:${requestIp}`);
      const result = await env.OEM_AUTH_RATE_LIMIT.limit({ key });
      if (!result.success) {
        throw new ApiError(429, "RATE_LIMITED", "Too many notification live connection attempts.");
      }
    }

    return proxyNotificationLive(
      env,
      request,
      user.uid,
      url.searchParams.get("clientId")?.trim() || crypto.randomUUID()
    );
  } catch (error) {
    return liveUpgradeError(error, requestId);
  }
}

function addCategoryRoutes(app: Hono<AppEnv>, category: NotificationCategory): void {
  app.get(`/${category}/messages`, requireAuth, rateLimit("auth"), async (c) => {
    const user = requireUser(c);
    const parsed = listQuerySchema.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
      unreadOnly: c.req.query("unreadOnly")
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid notification query.", parsed.error.flatten());
    }

    const [result, unread] = await Promise.all([
      listNotifications(c.env.DB, {
        userId: user.uid,
        category,
        limit: parsed.data.limit ?? 20,
        cursor: decodeNotificationCursor(parsed.data.cursor),
        unreadOnly: parsed.data.unreadOnly === "1"
      }),
      getNotificationUnreadCounts(c.env.DB, user.uid)
    ]);
    return noStore(c.json({
      items: result.items.map((item) => serializeNotificationItem(item)),
      nextCursor: result.nextCursor,
      unread
    }));
  });

  app.patch(`/${category}/messages/:id/read`, requireAuth, rateLimit("auth"), async (c) => {
    const user = requireUser(c);
    const notificationId = c.req.param("id")?.trim();
    if (!notificationId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Notification id is required.");
    }
    const changed = await markNotificationRead(c.env.DB, {
      userId: user.uid,
      category,
      id: notificationId
    });
    const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
    return noStore(c.json({ ok: true, changed, unread }));
  });

  app.post(`/${category}/messages/read`, requireAuth, rateLimit("auth"), async (c) => {
    const user = requireUser(c);
    const parsed = readManySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid notification read payload.", parsed.error.flatten());
    }
    const changed = await markNotificationsRead(c.env.DB, {
      userId: user.uid,
      category,
      ids: parsed.data.ids
    });
    const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
    return noStore(c.json({ ok: true, changed, unread }));
  });

  app.post(`/${category}/read-all`, requireAuth, rateLimit("auth"), async (c) => {
    const user = requireUser(c);
    const changed = await markAllNotificationsRead(c.env.DB, {
      userId: user.uid,
      category
    });
    const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
    return noStore(c.json({ ok: true, changed, unread }));
  });
}

export function createNotifyRoutes() {
  const app = new Hono<AppEnv>();

  addCategoryRoutes(app, "system");
  addCategoryRoutes(app, "community");

  app.get("/unread-count", requireAuth, rateLimit("auth"), async (c) => {
    const user = requireUser(c);
    const unread = await getNotificationUnreadCounts(c.env.DB, user.uid);
    return noStore(c.json({ unread }));
  });

  app.get("/live", requireAuth, rateLimit("auth"), async (c) => {
    const user = requireUser(c);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "WEBSOCKET_REQUIRED", "Notification live endpoint requires a WebSocket upgrade.");
    }

    return proxyNotificationLive(
      c.env,
      c.req.raw,
      user.uid,
      c.req.query("clientId")?.trim() || crypto.randomUUID()
    );
  });

  return app;
}
