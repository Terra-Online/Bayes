import { DurableObject } from "cloudflare:workers";
import { ApiError } from "../../lib/errors";
import {
  getNotificationById,
  getNotificationUnreadCounts,
  serializeNotificationItem,
  type NotificationRecord,
  type SerializedNotificationItem,
  type NotificationUnreadCounts
} from "../../repositories/notifications";
import type { Bindings } from "../../types/app";

export interface NotificationLiveEnvelope {
  event: "notification.upserted";
  notification: SerializedNotificationItem;
  unread: NotificationUnreadCounts;
}

export interface NotificationLiveReadyEnvelope {
  event: "notification.ready";
  unread: NotificationUnreadCounts;
}

interface WebSocketAttachment {
  uid: string;
  clientId: string;
  connectedAt: string;
}

const NOTIFICATION_HEARTBEAT_PATTERN = /^[A-Za-z0-9]{8}$/;

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {})
    }
  });
}

function makeInternalUrl(path: string): string {
  return `https://notify.internal${path}`;
}

export async function publishNotificationCreated(
  env: Bindings,
  notification: NotificationRecord
): Promise<void> {
  const hydrated = await getNotificationById(env.DB, notification.id);
  if (!hydrated) return;
  const unread = await getNotificationUnreadCounts(env.DB, hydrated.recipientUserId);
  const envelope: NotificationLiveEnvelope = {
    event: "notification.upserted",
    notification: serializeNotificationItem(hydrated),
    unread
  };

  const objectId = env.OEM_NOTIFICATION_DO.idFromName(hydrated.recipientUserId);
  const stub = env.OEM_NOTIFICATION_DO.get(objectId);
  const response = await stub.fetch(makeInternalUrl("/fanout"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oem-notify-user": hydrated.recipientUserId
    },
    body: JSON.stringify(envelope)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`notification fanout failed: ${response.status} ${detail.slice(0, 160)}`);
  }
}

export async function publishNotificationsCreated(
  env: Bindings,
  notifications: NotificationRecord[]
): Promise<void> {
  await Promise.all(notifications.map((notification) => publishNotificationCreated(env, notification)));
}

export class OEMNotificationDO extends DurableObject<Bindings> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/connect") {
      return this.handleConnect(request);
    }
    if (request.method === "POST" && url.pathname === "/fanout") {
      return this.handleFanout(request);
    }
    return jsonResponse({ code: "NOT_FOUND", message: "Notification DO route not found." }, { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    if (NOTIFICATION_HEARTBEAT_PATTERN.test(message)) {
      ws.send(message);
      return;
    }
    if (message === "close") {
      ws.close(1000, "client requested close");
      return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    console.warn("[notify] websocket closed", {
      clientId: attachment?.clientId ?? null,
      code,
      reason,
      wasClean,
      connectedForMs: attachment
        ? Math.max(0, Date.now() - Date.parse(attachment.connectedAt))
        : null
    });
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    console.error("[notify] websocket error", {
      clientId: attachment?.clientId ?? null,
      error
    });
    try {
      ws.close(1011, "websocket error");
    } catch {
      // Ignore close failures from already-closed sockets.
    }
  }

  private requireUser(request: Request): string {
    const uid = request.headers.get("x-oem-notify-user")?.trim();
    const objectName = this.ctx.id.name?.trim();
    if (!uid || !objectName || uid !== objectName) {
      throw new ApiError(403, "NOTIFICATION_DO_FORBIDDEN", "Notification Durable Object user mismatch.");
    }
    return uid;
  }

  private async handleConnect(request: Request): Promise<Response> {
    const uid = this.requireUser(request);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(
        { code: "WEBSOCKET_REQUIRED", message: "Notification live endpoint requires a WebSocket upgrade." },
        { status: 426 }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: WebSocketAttachment = {
      uid,
      clientId: request.headers.get("x-oem-notify-client-id")?.trim() || crypto.randomUUID(),
      connectedAt: new Date().toISOString()
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`uid:${uid}`]);

    // Send a post-upgrade snapshot so reconnects do not require a second REST
    // request just to recover the badge state.
    try {
      const unread = await getNotificationUnreadCounts(this.env.DB, uid);
      server.send(JSON.stringify({ event: "notification.ready", unread } satisfies NotificationLiveReadyEnvelope));
    } catch (error) {
      console.error("[notify] failed to send ready snapshot", {
        uid,
        clientId: attachment.clientId,
        error
      });
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private async handleFanout(request: Request): Promise<Response> {
    this.requireUser(request);
    const envelope = await request.json().catch(() => null) as NotificationLiveEnvelope | null;
    if (!envelope || envelope.event !== "notification.upserted" || !envelope.notification) {
      return jsonResponse({ code: "VALIDATION_ERROR", message: "Invalid notification fanout payload." }, { status: 422 });
    }

    const body = JSON.stringify(envelope);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(body);
        delivered += 1;
      } catch {
        try {
          socket.close(1011, "notification send failed");
        } catch {
          // Ignore close failures from already-closed sockets.
        }
      }
    }
    return jsonResponse({ ok: true, delivered });
  }
}
