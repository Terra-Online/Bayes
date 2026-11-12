import { Hono } from "hono";
import type { z } from "zod";

import { ApiError } from "@/lib/errors";
import {
  operation,
  sessionSecurity,
  optionalSessionSecurity,
  jsonResponse,
  apiErrorSchema,
} from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/locator";
import { readPosition } from "@/services/official/locator/position";
import { verifyLocatorSocketTicket } from "@/services/official/locator/ticket";
import type { AppEnv } from "@/types/app";

import { shouldIncludeBinding } from "./helpers";
import { resolveLocatorIdentity } from "./identity";
import { bridgePositionStream } from "./positionStream";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .get(
      "/position-stream",
      operation("connectPositionStream", "Locator", "Connect to the position WebSocket", {
        errors: [409, 502, 503],
        security: optionalSessionSecurity,
        query: docs.positionStreamQuerySchema,
        description:
          "Upgrade: websocket required. Authenticate with a short-lived ticket or a session. Identity and upstream failures can be sent as frames after the upgrade. See the client integration guide for the message protocol.",
        responses: {
          101: { description: "WebSocket connection established" },
          426: jsonResponse(apiErrorSchema, "WebSocket upgrade required"),
        },
      }),
      async (c) => {
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
      },
    )
    .get(
      "/position",
      operation("getPosition", "Locator", "Read the bound role position", {
        errors: [409, 502, 503],
        security: sessionSecurity,
        query: docs.positionQuerySchema,
        response: docs.positionResponseSchema,
        description:
          "Requires binding and policy agreement. socket_ticket=1 issues a short-lived ticket for the position stream. Cache state and age are in x-locator-cache and x-locator-age-ms.",
      }),
      async (c) => {
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
        } satisfies z.output<typeof docs.positionResponseSchema>);
        response.headers.set("cache-control", "private, no-store");
        response.headers.set("x-locator-cache", result.cacheState);
        response.headers.set("x-locator-age-ms", String(result.ageMs));
        return response;
      },
    );
}
