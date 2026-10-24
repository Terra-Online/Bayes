import type { Context } from "hono";
import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { resolveAuthIdentity } from "@/middleware/auth";
import { ensureUserProfile } from "@/repositories/users";
import { getPositionCacheKey, writePositionCache } from "@/services/locator/cache";
import { readPosition } from "@/services/locator/position";
import { positionReconnectDelay } from "@/services/locator/reconnect";
import { issueLocatorSocketTicket, verifyLocatorSocketTicket } from "@/services/locator/ticket";
import {
  createCredentialRecoveryScope,
  readBindingCredentials,
  isAutoRefreshableEndfieldError,
  recoverBindingCredentials,
} from "@/services/official/auth/credentials";
import type { DecryptedBinding } from "@/services/official/auth/types";
import {
  isEndfieldCredentialErrorCode,
  isEndfieldCredentialExpiredErrorCode,
  parseEndfieldPositionSocketError,
  parseEndfieldPositionSocketMessage,
} from "@/services/official/client/positionParser";
import {
  connectEndfieldPositionSocket,
  type EndfieldPositionConnection,
  type EndfieldPositionTermination,
} from "@/services/official/client/positionSocket";
import type { AppEnv } from "@/types/app";

import { serializeLocatorError, shouldIncludeBinding } from "./helpers";

type PositionStreamCloseReason =
  | "client-closed"
  | "client-stopped"
  | "page-lifecycle"
  | "client-recovery"
  | "client-command"
  | "client-error"
  | "send-failed"
  | "stream-unavailable";

const positionStreamCloseText: Record<PositionStreamCloseReason, string> = {
  "client-closed": "client closed",
  "client-stopped": "locator stopped",
  "page-lifecycle": "locator disposed",
  "client-recovery": "locator upstream state changed",
  "client-command": "closed",
  "client-error": "client socket error",
  "send-failed": "send failed",
  "stream-unavailable": "locator stream unavailable",
};

function classifyClientClose(event: CloseEvent): PositionStreamCloseReason {
  if (event.reason === "locator stopped") {
    return "client-stopped";
  }
  if (event.reason === "locator disposed" || event.reason === "page hidden") {
    return "page-lifecycle";
  }
  if (event.reason === "locator upstream state changed") {
    return "client-recovery";
  }
  return "client-closed";
}

async function resolvePositionBinding<E extends AppEnv<{ requestId: string }>>(
  c: Context<E>,
  ticketUid?: string,
): Promise<{ uid: string; binding: DecryptedBinding }> {
  if (ticketUid) {
    return {
      uid: ticketUid,
      binding: await readBindingCredentials({ uid: ticketUid }, c.env),
    };
  }

  const authHeaders = new Headers(c.req.raw.headers);
  const accessToken = c.req.query("access_token")?.trim();
  if (accessToken && !authHeaders.has("authorization")) {
    authHeaders.set("authorization", `Bearer ${accessToken}`);
  }

  const identity = await resolveAuthIdentity(c.env, authHeaders);
  const [binding] = await Promise.all([
    readBindingCredentials({ uid: identity.uid }, c.env),
    ensureUserProfile(c.env.DB, {
      uid: identity.uid,
      email: identity.email,
      displayName: identity.displayName,
    }),
  ]);
  return { uid: identity.uid, binding };
}

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

      const recoveryScope = createCredentialRecoveryScope();
      const includeBinding = shouldIncludeBinding(c);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      let closed = false;
      let upstream: EndfieldPositionConnection | undefined;
      const lifetime = new AbortController();
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let upstreamGeneration = 0;
      let reconnectAttempt = 0;
      let upstreamSubscribedAt: number | undefined;
      let userUid: string | undefined;
      let binding: DecryptedBinding | undefined;
      const streamStartedAt = Date.now();

      const close = (code = 1000, reason: PositionStreamCloseReason = "client-closed") => {
        if (closed) {
          return;
        }
        closed = true;
        console.warn("[locator][position-stream] closed", {
          code,
          reason,
          lifetimeMs: Date.now() - streamStartedAt,
          upstreamLifetimeMs:
            upstreamSubscribedAt === undefined ? 0 : Date.now() - upstreamSubscribedAt,
          reconnectAttempts: reconnectAttempt,
        });
        upstreamGeneration += 1;
        if (reconnectTimer !== undefined) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        lifetime.abort();
        const closeText = positionStreamCloseText[reason];
        upstream?.close(1000, closeText);
        upstream = undefined;
        server.removeEventListener("close", onClientClose);
        server.removeEventListener("error", onClientError);
        server.removeEventListener("message", onClientMessage);
        try {
          server.close(code, closeText);
        } catch {
          /* Peer may already be closed. */
        }
      };

      const scheduleReconnect = (
        reason: "upstream-closed" | "upstream-error" | "credentials-refresh" | "bridge-failed",
        termination?: EndfieldPositionTermination,
      ) => {
        if (closed || reconnectTimer !== undefined || !binding || !userUid) {
          return;
        }
        const upstreamLifetimeMs =
          upstreamSubscribedAt === undefined ? 0 : Date.now() - upstreamSubscribedAt;
        if (upstreamSubscribedAt !== undefined && Date.now() - upstreamSubscribedAt >= 60_000) {
          reconnectAttempt = 0;
        }
        upstreamSubscribedAt = undefined;
        const delay = positionReconnectDelay(reconnectAttempt++);
        console.warn("[locator][position-stream] reconnect scheduled", {
          reason,
          delayMs: delay,
          upstreamLifetimeMs,
          lifetimeMs: Date.now() - streamStartedAt,
          reconnectAttempt,
          ...(termination
            ? {
                upstreamTermination: termination.kind,
                upstreamPhase: termination.phase,
                upstreamCode: termination.code,
                upstreamConnectionLifetimeMs: termination.lifetimeMs,
              }
            : {}),
        });
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          void bridgeUpstream();
        }, delay);
        upstream?.close(1000, "reconnecting");
        upstream = undefined;
      };

      const sendJson = (payload: unknown) => {
        if (closed) {
          return;
        }
        try {
          server.send(JSON.stringify(payload));
        } catch {
          close(1011, "send-failed");
        }
      };

      const bridgeUpstream = async (announceConnecting = true) => {
        const currentBinding = binding;
        const currentUserUid = userUid;
        if (closed || !currentBinding || !currentUserUid) {
          return;
        }
        const generation = upstreamGeneration + 1;
        upstreamGeneration = generation;
        try {
          if (announceConnecting) {
            sendJson({
              type: "status",
              status: "connecting",
            });
          }
          if (closed) {
            return;
          }
          const connectedSocket = await connectEndfieldPositionSocket(
            {
              provider: currentBinding.binding.provider,
              roleId: currentBinding.binding.role_id,
              serverId: Number(currentBinding.binding.server_id),
              cred: currentBinding.cred,
              token: currentBinding.token,
              wsBaseUrl: c.env.ENDFIELD_WS_BASE_URL,
              signal: lifetime.signal,
              deviceProfile: currentBinding.deviceProfile,
            },
            {
              onSubscribed: () => {
                if (closed || generation !== upstreamGeneration) {
                  return;
                }
                upstreamSubscribedAt ??= Date.now();
                sendJson({
                  type: "status",
                  status: "connected",
                });
              },
              onMessage: (data) => {
                if (closed || generation !== upstreamGeneration) {
                  return;
                }
                const error = parseEndfieldPositionSocketError(data);
                if (error) {
                  const credentialRejected = isEndfieldCredentialErrorCode(error.code);
                  const credentialExpired = isEndfieldCredentialExpiredErrorCode(error.code);
                  const deviceRejected = error.code === 10001;
                  let code = "ENDFIELD_POSITION_UNAVAILABLE";
                  let message =
                    "Player is not currently logged into the game or position is unavailable.";
                  if (deviceRejected) {
                    code = "ENDFIELD_DEVICE_REJECTED";
                    message = error.message ?? "Endfield device information was rejected.";
                  } else if (credentialRejected) {
                    code = "ENDFIELD_CREDENTIAL_REJECTED";
                    message = error.message ?? "Endfield credential was rejected.";
                  }
                  const errorPayload = {
                    type: "error",
                    requestId: c.get("requestId"),
                    error: {
                      status: deviceRejected ? 502 : 401,
                      code,
                      message,
                      details: {
                        upstreamCode: error.code,
                        upstreamMessage: error.message,
                      },
                      requestId: c.get("requestId"),
                    },
                  };
                  if ((credentialRejected && !credentialExpired) || deviceRejected) {
                    upstreamGeneration += 1;
                    const recoveryGeneration = upstreamGeneration;
                    sendJson({
                      type: "status",
                      status: "reconnecting",
                      reason: deviceRejected
                        ? "refreshing device profile"
                        : "refreshing credentials",
                    });
                    upstream?.close(1000, "refreshing credentials");
                    upstream = undefined;
                    const recovery = recoverBindingCredentials(
                      {
                        uid: currentUserUid,
                        rejectedCredentials: currentBinding,
                        rejection: new ApiError(
                          errorPayload.error.status,
                          code,
                          message,
                          errorPayload.error.details,
                        ),
                      },
                      { env: c.env, recoveryScope },
                    )
                      .then((refreshed) => {
                        if (closed || recoveryGeneration !== upstreamGeneration) {
                          return;
                        }
                        binding = refreshed;
                        scheduleReconnect("credentials-refresh");
                      })
                      .catch(() => {
                        if (!closed && recoveryGeneration === upstreamGeneration) {
                          sendJson(errorPayload);
                        }
                      });
                    c.executionCtx.waitUntil(recovery);
                    return;
                  }
                  sendJson(errorPayload);
                  return;
                }

                const position = parseEndfieldPositionSocketMessage(data);
                if (!position) {
                  return;
                }
                writePositionCache(
                  c.env,
                  getPositionCacheKey(currentUserUid, currentBinding.binding),
                  {
                    data: position,
                    refreshedAt: Date.now(),
                  },
                );
                sendJson({
                  type: "position",
                  data: position,
                  ...(includeBinding ? { binding: currentBinding.publicBinding } : {}),
                });
              },
              onClose: (termination) => {
                if (!closed && generation === upstreamGeneration) {
                  upstreamGeneration += 1;
                  sendJson({
                    type: "status",
                    status: "reconnecting",
                    reason: "upstream closed",
                  });
                  scheduleReconnect("upstream-closed", termination);
                }
              },
              onError: (termination) => {
                if (!closed && generation === upstreamGeneration) {
                  upstreamGeneration += 1;
                  sendJson({
                    type: "status",
                    status: "reconnecting",
                    reason: "upstream error",
                  });
                  scheduleReconnect("upstream-error", termination);
                }
              },
            },
          );
          if (closed || generation !== upstreamGeneration) {
            connectedSocket.close(1000, "connection superseded");
            return;
          }
          upstream = connectedSocket;
        } catch (error) {
          if (closed || generation !== upstreamGeneration) {
            return;
          }
          const details =
            error instanceof ApiError
              ? (error.details as { upstreamCode?: unknown; upstreamStatus?: unknown } | undefined)
              : undefined;
          if (
            error instanceof ApiError &&
            isEndfieldCredentialExpiredErrorCode(details?.upstreamCode)
          ) {
            sendJson({
              type: "error",
              error: serializeLocatorError(error, c.get("requestId")),
              requestId: c.get("requestId"),
            });
            return;
          }
          if (isAutoRefreshableEndfieldError(error)) {
            const refreshed = await recoverBindingCredentials(
              { uid: currentUserUid, rejectedCredentials: currentBinding, rejection: error },
              { env: c.env, recoveryScope },
            ).catch(() => null);
            if (closed || generation !== upstreamGeneration) {
              return;
            }
            if (refreshed) {
              binding = refreshed;
              scheduleReconnect("credentials-refresh");
              return;
            }
            if (
              error instanceof ApiError &&
              (error.code === "ENDFIELD_CREDENTIAL_REJECTED" ||
                isEndfieldCredentialErrorCode(details?.upstreamCode) ||
                (error.code === "ENDFIELD_POSITION_SOCKET_UNAVAILABLE" &&
                  (details?.upstreamStatus === 401 || details?.upstreamStatus === 403)))
            ) {
              sendJson({
                type: "error",
                error: serializeLocatorError(error, c.get("requestId")),
                requestId: c.get("requestId"),
              });
              return;
            }
          }
          sendJson({
            type: "error",
            error: serializeLocatorError(error, c.get("requestId")),
            requestId: c.get("requestId"),
          });
          scheduleReconnect("bridge-failed");
        }
      };

      const initializeStream = async () => {
        if (closed) {
          return;
        }
        try {
          const resolved = await resolvePositionBinding(c, ticketUid ?? undefined);
          if (closed) {
            return;
          }
          userUid = resolved.uid;
          binding = resolved.binding;
          void bridgeUpstream(false);
        } catch (error) {
          sendJson({
            type: "error",
            error: serializeLocatorError(error, c.get("requestId")),
            requestId: c.get("requestId"),
          });
          close(
            error instanceof ApiError && error.status === 401 ? 1008 : 1011,
            "stream-unavailable",
          );
        }
      };

      server.accept();
      function onClientClose(event: CloseEvent) {
        close(event.code || 1000, classifyClientClose(event));
      }
      function onClientError() {
        close(1011, "client-error");
      }
      function onClientMessage(event: MessageEvent) {
        if (event.data === "close") {
          close(1000, "client-command");
        }
      }
      server.addEventListener("close", onClientClose);
      server.addEventListener("error", onClientError);
      server.addEventListener("message", onClientMessage);
      sendJson({
        type: "status",
        status: "connecting",
      });

      c.executionCtx.waitUntil(initializeStream());

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    })
    .get("/position", async (c) => {
      const resolved = await resolvePositionBinding(c);
      const includeBinding = shouldIncludeBinding(c);
      const includeSocketTicket = c.req.query("socket_ticket") === "1";
      const socketTicket = includeSocketTicket
        ? await issueLocatorSocketTicket(c.env, resolved.uid)
        : undefined;
      const result = await readPosition({ uid: resolved.uid, binding: resolved.binding }, c.env);
      if (result.backgroundRefresh) {
        c.executionCtx.waitUntil(result.backgroundRefresh);
      }
      const response = c.json({
        data: result.data,
        ...(socketTicket ? { socketTicket } : {}),
        ...(includeBinding ? { binding: result.binding } : {}),
      });
      response.headers.set("cache-control", "private, no-store");
      response.headers.set("x-locator-cache", result.cacheState);
      response.headers.set("x-locator-age-ms", String(result.ageMs));
      return response;
    });
}
