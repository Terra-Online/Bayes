import { connectEndfieldPositionSocket } from "../../lib/endfieldClient/positionSocket";
import {
  isEndfieldCredentialErrorCode,
  parseEndfieldPositionSocketError,
  parseEndfieldPositionSocketMessage
} from "../../lib/endfieldClient/positionParser";
import { ApiError } from "../../lib/errors";
import { resolveAuthIdentity } from "../../middleware/auth";
import { ensureUserProfile } from "../../repositories/users";
import {
  getDecryptedBinding,
  isAutoRefreshableEndfieldError,
  refreshBindingCredentials,
  withAutoRefreshedBinding
} from "./credentials";
import { POSITION_STREAM_RECONNECT_MS, serializeLocatorError, shouldIncludeBinding } from "./helpers";
import { issueLocatorSocketTicket, verifyLocatorSocketTicket } from "./locatorTicket";
import {
  getPositionCacheKey,
  POSITION_CACHE_FRESH_MS,
  POSITION_CACHE_STALE_MS,
  positionCache,
  refreshPositionCache
} from "./locatorCache";
import type { AppContext, DecryptedBinding } from "./types";

async function resolvePositionBinding(
  c: AppContext,
  ticketUid?: string
): Promise<{ uid: string; binding: DecryptedBinding }> {
  if (ticketUid) {
    return {
      uid: ticketUid,
      binding: await getDecryptedBinding(c, ticketUid)
    };
  }

  const authHeaders = new Headers(c.req.raw.headers);
  const accessToken = c.req.query("access_token")?.trim();
  if (accessToken && !authHeaders.has("authorization")) {
    authHeaders.set("authorization", `Bearer ${accessToken}`);
  }

  const identity = await resolveAuthIdentity(c.env, authHeaders);
  const [binding] = await Promise.all([
    getDecryptedBinding(c, identity.uid),
    ensureUserProfile(c.env.DB, {
      uid: identity.uid,
      email: identity.email,
      displayName: identity.displayName
    })
  ]);
  return { uid: identity.uid, binding };
}

function schedulePositionRefresh(c: AppContext, key: string, binding: DecryptedBinding): void {
  const refresh = refreshPositionCache(key, binding).catch(() => undefined);
  c.executionCtx.waitUntil(refresh);
}

export async function handleEndfieldPositionSocket(c: AppContext) {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(426, "WEBSOCKET_REQUIRED", "Use a WebSocket connection for this endpoint.");
  }

  const ticket = c.req.query("ticket")?.trim();
  const ticketUid = ticket
    ? await verifyLocatorSocketTicket(c.env, ticket)
    : undefined;
  if (ticket && !ticketUid) {
    throw new ApiError(401, "LOCATOR_SOCKET_TICKET_INVALID", "Locator socket ticket is invalid or expired.");
  }

  const includeBinding = shouldIncludeBinding(c);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  let closed = false;
  let upstream: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let upstreamGeneration = 0;
  let userUid: string | undefined;
  let binding: DecryptedBinding | undefined;

  const close = () => {
    closed = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    try {
      upstream?.close(1000, "client closed");
    } catch {
      // upstream is already closed
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined || !binding || !userUid) return;
    try {
      upstream?.close(1000, "reconnecting");
    } catch {
      // upstream is already closed
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void bridgeUpstream();
    }, POSITION_STREAM_RECONNECT_MS);
  };

  const sendJson = (payload: unknown) => {
    if (closed) return;
    try {
      server.send(JSON.stringify(payload));
    } catch {
      close();
    }
  };

  const bridgeUpstream = async (announceConnecting = true) => {
    const currentBinding = binding;
    const currentUserUid = userUid;
    if (!currentBinding || !currentUserUid) return;
    const generation = upstreamGeneration + 1;
    upstreamGeneration = generation;
    try {
      if (announceConnecting) {
        sendJson({
          type: "status",
          status: "connecting"
        });
      }
      const connectedSocket = await connectEndfieldPositionSocket({
        provider: currentBinding.binding.provider,
        roleId: currentBinding.binding.role_id,
        serverId: Number(currentBinding.binding.server_id),
        cred: currentBinding.cred,
        token: currentBinding.token,
        wsBaseUrl: c.env.ENDFIELD_WS_BASE_URL,
        deviceProfile: currentBinding.deviceProfile
      }, {
        onSubscribed: () => {
          if (closed || generation !== upstreamGeneration) return;
          sendJson({
            type: "status",
            status: "connected"
          });
        },
        onMessage: (data) => {
          if (generation !== upstreamGeneration) return;
          const error = parseEndfieldPositionSocketError(data);
          if (error) {
            const credentialRejected = isEndfieldCredentialErrorCode(error.code);
            const deviceRejected = error.code === 10001;
            const errorPayload = {
              type: "error",
              error: {
                status: deviceRejected ? 502 : 401,
                code: deviceRejected
                  ? "ENDFIELD_DEVICE_REJECTED"
                  : (credentialRejected ? "ENDFIELD_CREDENTIAL_REJECTED" : "ENDFIELD_POSITION_UNAVAILABLE"),
                message: deviceRejected
                  ? (error.message ?? "Endfield device information was rejected.")
                  : credentialRejected
                  ? (error.message ?? "Endfield credential was rejected.")
                  : "Player is not currently logged into the game or position is unavailable.",
                details: {
                  upstreamCode: error.code,
                  upstreamMessage: error.message
                }
              }
            };
            if (credentialRejected || deviceRejected) {
              upstreamGeneration += 1;
              sendJson({
                type: "status",
                status: "reconnecting",
                reason: deviceRejected ? "refreshing device profile" : "refreshing credentials"
              });
              try {
                upstream?.close(1000, "refreshing credentials");
              } catch {
                // upstream is already closed
              }
              const recovery = refreshBindingCredentials(c, currentUserUid, currentBinding)
                .then((refreshed) => {
                  if (closed || !refreshed) return;
                  binding = refreshed;
                  scheduleReconnect();
                })
                .catch(() => {
                  if (!closed) sendJson(errorPayload);
                });
              c.executionCtx.waitUntil(recovery);
              return;
            }
            sendJson(errorPayload);
            return;
          }

          const position = parseEndfieldPositionSocketMessage(data);
          if (!position) return;
          positionCache.set(getPositionCacheKey(currentUserUid, currentBinding.binding), {
            data: position,
            refreshedAt: Date.now()
          });
          sendJson({
            type: "position",
            data: position,
            ...(includeBinding ? { binding: currentBinding.publicBinding } : {})
          });
        },
        onClose: () => {
          if (!closed && generation === upstreamGeneration) {
            upstreamGeneration += 1;
            sendJson({
              type: "status",
              status: "reconnecting",
              reason: "upstream closed"
            });
            scheduleReconnect();
          }
        },
        onError: () => {
          if (!closed && generation === upstreamGeneration) {
            upstreamGeneration += 1;
            sendJson({
              type: "status",
              status: "reconnecting",
              reason: "upstream error"
            });
            scheduleReconnect();
          }
        }
      });
      if (closed || generation !== upstreamGeneration) {
        connectedSocket.close(1000, "connection superseded");
        return;
      }
      upstream = connectedSocket;
    } catch (error) {
      if (isAutoRefreshableEndfieldError(error)) {
        const refreshed = await refreshBindingCredentials(c, currentUserUid, currentBinding).catch(() => null);
        if (refreshed && !closed) {
          binding = refreshed;
          scheduleReconnect();
          return;
        }
        const details = error instanceof ApiError
          ? error.details as { upstreamCode?: unknown; upstreamStatus?: unknown } | undefined
          : undefined;
        if (
          error instanceof ApiError
          && (
            error.code === "ENDFIELD_CREDENTIAL_REJECTED"
            || isEndfieldCredentialErrorCode(details?.upstreamCode)
            || (
              error.code === "ENDFIELD_POSITION_SOCKET_UNAVAILABLE"
              && (details?.upstreamStatus === 401 || details?.upstreamStatus === 403)
            )
          )
        ) {
          sendJson({
            type: "error",
            error: serializeLocatorError(error)
          });
          return;
        }
      }
      sendJson({
        type: "error",
        error: serializeLocatorError(error)
      });
      scheduleReconnect();
    }
  };

  const initializeStream = async () => {
    try {
      const resolved = await resolvePositionBinding(c, ticketUid ?? undefined);
      if (closed) return;
      userUid = resolved.uid;
      binding = resolved.binding;
      void bridgeUpstream(false);
    } catch (error) {
      sendJson({
        type: "error",
        error: serializeLocatorError(error)
      });
      close();
      try {
        server.close(error instanceof ApiError && error.status === 401 ? 1008 : 1011, "locator stream unavailable");
      } catch {
        // socket is already closed
      }
    }
  };

  server.accept();
  sendJson({
    type: "status",
    status: "connecting"
  });
  server.addEventListener("close", close);
  server.addEventListener("error", close);
  server.addEventListener("message", (event) => {
    if (event.data === "close") {
      server.close(1000, "closed");
      close();
    }
  });

  c.executionCtx.waitUntil(initializeStream());

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

export async function handleEndfieldPosition(c: AppContext) {
  const resolved = await resolvePositionBinding(c);
  const includeBinding = shouldIncludeBinding(c);
  const includeSocketTicket = c.req.query("socket_ticket") === "1";
  const socketTicket = includeSocketTicket
    ? await issueLocatorSocketTicket(c.env, resolved.uid)
    : undefined;
  return withAutoRefreshedBinding(c, resolved.uid, async (binding) => {
    const cacheKey = getPositionCacheKey(resolved.uid, binding.binding);
    const cached = positionCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.refreshedAt <= POSITION_CACHE_STALE_MS) {
      if (now - cached.refreshedAt > POSITION_CACHE_FRESH_MS) {
        schedulePositionRefresh(c, cacheKey, binding);
      }

      const response = c.json({
        data: cached.data,
        ...(socketTicket ? { socketTicket } : {}),
        ...(includeBinding ? { binding: binding.publicBinding } : {})
      });
      response.headers.set("cache-control", "private, no-store");
      response.headers.set("x-locator-cache", now - cached.refreshedAt <= POSITION_CACHE_FRESH_MS ? "fresh" : "stale");
      response.headers.set("x-locator-age-ms", String(now - cached.refreshedAt));
      return response;
    }

    const position = await refreshPositionCache(cacheKey, binding);

    const response = c.json({
      data: position.data,
      ...(socketTicket ? { socketTicket } : {}),
      ...(includeBinding ? { binding: binding.publicBinding } : {})
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-locator-cache", "miss");
    response.headers.set("x-locator-age-ms", "0");
    return response;
  }, resolved.binding);
}
