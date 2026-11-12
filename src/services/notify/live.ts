import { DurableObject } from "cloudflare:workers";

import { ApiError } from "@/lib/errors";
import {
  getNotificationById,
  getNotificationUnreadCounts,
  serializeNotificationItem,
  type NotificationRecord,
  type SerializedNotificationItem,
  type NotificationUnreadCounts,
} from "@/repositories/notifications";
import type { Bindings } from "@/types/app";

import type { NotificationReadChange } from "./read";

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

// Per read event, including the initiating connection if selected.
const MAX_READ_SYNC_CONNECTIONS = 10;

const NOTIFICATION_HEARTBEAT_PATTERN = /^[A-Za-z0-9]{8}$/;
// The client switches back to nonce heartbeats after any missed acknowledgement,
// so a delayed static echo cannot acknowledge a subsequent probe.
const NOTIFICATION_AUTO_HEARTBEAT = "OEMping1";

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function makeInternalUrl(path: string): string {
  return `https://notify.internal${path}`;
}

export async function publishNotificationCreated(
  env: Bindings,
  notification: NotificationRecord,
): Promise<void> {
  const hydrated = await getNotificationById(env.DB, notification.id);
  if (!hydrated) {
    return;
  }
  const unread = await getNotificationUnreadCounts(env.DB, hydrated.recipientUserId);
  const envelope: NotificationLiveEnvelope = {
    event: "notification.upserted",
    notification: serializeNotificationItem(hydrated),
    unread,
  };

  const objectId = env.OEM_NOTIFICATION_DO.idFromName(hydrated.recipientUserId);
  const stub = env.OEM_NOTIFICATION_DO.get(objectId);
  const response = await stub.fetch(makeInternalUrl("/fanout"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oem-notify-user": hydrated.recipientUserId,
    },
    body: JSON.stringify(envelope),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`notification fanout failed: ${response.status} ${detail.slice(0, 160)}`);
  }
}

export async function publishNotificationsCreated(
  env: Bindings,
  notifications: NotificationRecord[],
): Promise<void> {
  for (const notification of notifications) {
    try {
      await publishNotificationCreated(env, notification);
    } catch (error) {
      console.error("[notify] live delivery failed; notification remains persisted", {
        notificationId: notification.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export class OEMNotificationDO extends DurableObject<Bindings> {
  private pendingDelivery: Promise<unknown> = Promise.resolve();

  // Keep each D1 read and its broadcast together, in DO arrival order.
  // This is an in-memory sequence, not a retry queue.
  private enqueueDelivery(operation: () => Promise<Response>): Promise<Response> {
    const result = this.pendingDelivery.then(operation);
    // Let the next operation run after a failure; return the original result to the caller.
    this.pendingDelivery = result.catch(() => undefined);
    return result;
  }
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(NOTIFICATION_AUTO_HEARTBEAT, NOTIFICATION_AUTO_HEARTBEAT),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/connect") {
      return this.enqueueDelivery(() => this.handleConnect(request));
    }
    if (request.method === "POST" && url.pathname === "/fanout") {
      return this.enqueueDelivery(() => this.handleFanout(request));
    }
    if (request.method === "POST" && url.pathname === "/read") {
      return this.enqueueDelivery(() => this.handleRead(request));
    }
    return jsonResponse(
      { code: "NOT_FOUND", message: "Notification DO route not found." },
      { status: 404 },
    );
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    if (NOTIFICATION_HEARTBEAT_PATTERN.test(message)) {
      try {
        ws.send(message);
      } catch (error) {
        await this.webSocketError(ws, error);
      }
      return;
    }
    if (message === "close") {
      try {
        ws.close(1000, "client requested close");
      } catch {
        // Closing is best-effort; the client may already have disconnected.
      }
      return;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    try {
      ws.close(1000, "peer closed");
    } catch {
      // Continue recording the close event even if the socket is already closed.
    }
    if (wasClean && (code === 1000 || code === 1001)) {
      return;
    }
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    console.warn("[notify] websocket closed", {
      clientId: attachment?.clientId ?? null,
      code,
      reason,
      wasClean,
      connectedForMs: attachment
        ? Math.max(0, Date.now() - Date.parse(attachment.connectedAt))
        : null,
    });
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    console.error("[notify] websocket error", {
      clientId: attachment?.clientId ?? null,
      error,
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
      throw new ApiError(
        403,
        "NOTIFICATION_DO_FORBIDDEN",
        "Notification Durable Object user mismatch.",
      );
    }
    return uid;
  }

  private async handleConnect(request: Request): Promise<Response> {
    const uid = this.requireUser(request);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(
        {
          code: "WEBSOCKET_REQUIRED",
          message: "Notification live endpoint requires a WebSocket upgrade.",
        },
        { status: 426 },
      );
    }

    const clientId = request.headers.get("x-oem-notify-client-id")?.trim() || crypto.randomUUID();
    const unread = await getNotificationUnreadCounts(this.env.DB, uid);
    for (const socket of this.ctx.getWebSockets()) {
      const previous = socket.deserializeAttachment() as WebSocketAttachment | null;
      if (previous?.clientId === clientId) {
        try {
          socket.close(1000, "connection replaced");
        } catch {
          // A stale connection must not prevent the replacement from connecting.
        }
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: WebSocketAttachment = {
      uid,
      clientId,
      connectedAt: new Date().toISOString(),
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`uid:${uid}`]);

    // Send a post-upgrade snapshot so reconnects do not require a second REST
    // request just to recover the badge state.
    try {
      server.send(
        JSON.stringify({
          event: "notification.ready",
          unread,
        } satisfies NotificationLiveReadyEnvelope),
      );
    } catch (error) {
      console.error("[notify] failed to send ready snapshot", {
        uid,
        clientId: attachment.clientId,
        error,
      });
      try {
        server.close(1011, "ready snapshot failed");
      } catch {
        // Preserve the original ready-snapshot error if closing also fails.
      }
      throw error;
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleFanout(request: Request): Promise<Response> {
    const uid = this.requireUser(request);
    const envelope = (await request.json().catch(() => null)) as {
      event?: string;
      notification?: { id?: string };
    } | null;
    if (
      !envelope ||
      envelope.event !== "notification.upserted" ||
      typeof envelope.notification?.id !== "string"
    ) {
      return jsonResponse(
        { code: "VALIDATION_ERROR", message: "Invalid notification fanout payload." },
        { status: 422 },
      );
    }

    // An earlier queued creation may reach this object after its read update.
    const current = await getNotificationById(this.env.DB, envelope.notification.id);
    if (!current || current.recipientUserId !== uid) {
      return jsonResponse({ ok: true, delivered: 0 });
    }
    const body = JSON.stringify({
      event: "notification.upserted",
      notification: serializeNotificationItem(current),
      unread: await getNotificationUnreadCounts(this.env.DB, uid),
    } satisfies NotificationLiveEnvelope);
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

  private async handleRead(request: Request): Promise<Response> {
    const uid = this.requireUser(request);
    const change = (await request.json().catch(() => null)) as NotificationReadChange | null;
    if (
      !change ||
      !["community", "system"].includes(change.category) ||
      !Number.isFinite(Date.parse(change.readAt)) ||
      (change.ids !== null &&
        (!Array.isArray(change.ids) ||
          change.ids.length > 100 ||
          !change.ids.every((id) => typeof id === "string")))
    ) {
      return jsonResponse({ code: "VALIDATION_ERROR" }, { status: 422 });
    }
    const sockets = this.ctx
      .getWebSockets()
      .map((socket) => ({
        socket,
        attachment: socket.deserializeAttachment() as WebSocketAttachment | null,
      }))
      .filter(({ attachment }) => attachment?.uid === uid)
      .sort((a, b) => Date.parse(b.attachment!.connectedAt) - Date.parse(a.attachment!.connectedAt))
      .slice(0, MAX_READ_SYNC_CONNECTIONS);
    if (sockets.length === 0) {
      return jsonResponse({ ok: true, delivered: 0 });
    }
    const unread = await getNotificationUnreadCounts(this.env.DB, uid);
    const body = JSON.stringify({ event: "notification.read", ...change, unread });
    let delivered = 0;
    for (const { socket } of sockets) {
      try {
        socket.send(body);
        delivered++;
      } catch {
        // Reconnection's ready snapshot repairs missed updates.
        try {
          socket.close(1011, "notification send failed");
        } catch {
          /* already closed */
        }
      }
    }
    return jsonResponse({ ok: true, delivered });
  }
}
