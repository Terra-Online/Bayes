import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { readPosition } from "@/services/official/locator/position";
import { verifyLocatorSocketTicket } from "@/services/official/locator/ticket";
import type { AppEnv } from "@/types/app";

import { shouldIncludeBinding } from "./helpers";
import { resolveLocatorIdentity } from "./identity";
import { bridgePositionStream } from "./positionStream";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .get("/position-stream", async (c) => {
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
        throw new ApiError(
          426,
          "WEBSOCKET_REQUIRED",
          "Use a WebSocket connection for this endpoint.",
        );
      }
      const ticket = c.req.query("ticket")?.trim();
      const ticketUid = ticket ? await verifyLocatorSocketTicket(c.env, ticket) : undefined;
      if (ticket && !ticketUid) {
        throw new ApiError(
          401,
          "LOCATOR_SOCKET_TICKET_INVALID",
          "Locator socket ticket is invalid or expired.",
        );
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      bridgePositionStream(server, c.env, {
        resolveIdentity: () => resolveLocatorIdentity(c, ticketUid ?? undefined),
        includeBinding: shouldIncludeBinding(c),
        requestId: c.get("requestId"),
        schedule: (task) => c.executionCtx.waitUntil(task),
      });
      return new Response(null, { status: 101, webSocket: client });
    })
    .get("/position", async (c) => {
      const identity = await resolveLocatorIdentity(c);
      const result = await readPosition(
        { identity, includeSocketTicket: c.req.query("socket_ticket") === "1" },
        c.env,
      );
      if (result.backgroundRefresh) {
        c.executionCtx.waitUntil(result.backgroundRefresh);
      }
      const response = c.json({
        data: result.data,
        ...(result.socketTicket ? { socketTicket: result.socketTicket } : {}),
        ...(shouldIncludeBinding(c) ? { binding: result.binding } : {}),
      });
      response.headers.set("cache-control", "private, no-store");
      response.headers.set("x-locator-cache", result.cacheState);
      response.headers.set("x-locator-age-ms", String(result.ageMs));
      return response;
    });
}
