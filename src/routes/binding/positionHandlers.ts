import { connectEndfieldPositionSocket } from "../../lib/endfieldClient/positionSocket";
import { parseEndfieldPositionSocketError, parseEndfieldPositionSocketMessage } from "../../lib/endfieldClient/positionParser";
import { ApiError } from "../../lib/errors";
import { resolveAuthUser } from "../../middleware/auth";
import { getDecryptedBinding, isAutoRefreshableEndfieldError, refreshBindingCredentials, withAutoRefreshedBinding } from "./credentials";
import { POSITION_STREAM_RECONNECT_MS, requireUser, serializeLocatorError, shouldIncludeBinding } from "./helpers";
import {
  getPositionCacheKey,
  POSITION_CACHE_FRESH_MS,
  POSITION_CACHE_STALE_MS,
  positionCache,
  refreshPositionCache
} from "./locatorCache";
import type { AppContext, DecryptedBinding } from "./types";

function schedulePositionRefresh(c: AppContext, key: string, binding: DecryptedBinding): void {
  const refresh = refreshPositionCache(key, binding).catch(() => undefined);
  c.executionCtx.waitUntil(refresh);
}

export async function handleEndfieldPositionSocket(c: AppContext) {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(426, "WEBSOCKET_REQUIRED", "Use a WebSocket connection for this endpoint.");
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

  const bridgeUpstream = async () => {
    const currentBinding = binding;
    const currentUserUid = userUid;
    if (!currentBinding || !currentUserUid) return;
    const generation = upstreamGeneration + 1;
    upstreamGeneration = generation;
    try {
      sendJson({
        type: "status",
        status: "connecting"
      });
      upstream = await connectEndfieldPositionSocket({
        provider: currentBinding.binding.provider,
        roleId: currentBinding.binding.role_id,
        serverId: Number(currentBinding.binding.server_id),
        cred: currentBinding.cred,
        token: currentBinding.token,
        wsBaseUrl: c.env.ENDFIELD_WS_BASE_URL,
        deviceProfile: currentBinding.deviceProfile
      });
      sendJson({
        type: "status",
        status: "connected"
      });

      upstream.addEventListener("message", (event) => {
        if (generation !== upstreamGeneration) return;
        const error = parseEndfieldPositionSocketError(event.data as string | ArrayBuffer);
        if (error?.code === 10000) {
          sendJson({
            type: "error",
            error: {
              status: 401,
              code: "ENDFIELD_CREDENTIAL_REJECTED",
              message: error.message ?? "Endfield credential was rejected.",
              details: {
                upstreamCode: error.code,
                upstreamMessage: error.message
              }
            }
          });
          return;
        }

        const position = parseEndfieldPositionSocketMessage(event.data as string | ArrayBuffer);
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
      });
      upstream.addEventListener("close", () => {
        if (!closed && generation === upstreamGeneration) {
          upstreamGeneration += 1;
          sendJson({
            type: "status",
            status: "reconnecting",
            reason: "upstream closed"
          });
          scheduleReconnect();
        }
      });
      upstream.addEventListener("error", () => {
        if (!closed && generation === upstreamGeneration) {
          upstreamGeneration += 1;
          sendJson({
            type: "status",
            status: "reconnecting",
            reason: "upstream error"
          });
          scheduleReconnect();
        }
      });
    } catch (error) {
      if (isAutoRefreshableEndfieldError(error)) {
        const refreshed = await refreshBindingCredentials(c, currentUserUid, currentBinding).catch(() => null);
        if (refreshed && !closed) {
          binding = refreshed;
          scheduleReconnect();
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
      const authHeaders = new Headers(c.req.raw.headers);
      const accessToken = c.req.query("access_token")?.trim();
      if (accessToken && !authHeaders.has("authorization")) {
        authHeaders.set("authorization", `Bearer ${accessToken}`);
      }
      const user = await resolveAuthUser(c.env, authHeaders);
      if (closed) return;
      const decrypted = await getDecryptedBinding(c, user.uid);
      if (closed) return;
      userUid = user.uid;
      binding = decrypted;
      void bridgeUpstream();
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
  const user = requireUser(c);
  const includeBinding = shouldIncludeBinding(c);
  return withAutoRefreshedBinding(c, user.uid, async (binding) => {
    const cacheKey = getPositionCacheKey(user.uid, binding.binding);
    const cached = positionCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.refreshedAt <= POSITION_CACHE_STALE_MS) {
      if (now - cached.refreshedAt > POSITION_CACHE_FRESH_MS) {
        schedulePositionRefresh(c, cacheKey, binding);
      }

      const response = c.json({
        data: cached.data,
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
      ...(includeBinding ? { binding: binding.publicBinding } : {})
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-locator-cache", "miss");
    response.headers.set("x-locator-age-ms", "0");
    return response;
  });
}
