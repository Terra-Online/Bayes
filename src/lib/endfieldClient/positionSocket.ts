import { ApiError } from "../errors";
import { parseApiEnvelope } from "./envelope";
import { buildDeviceHeaders, buildUrl, buildWebSocketHttpUrl, getEndfieldHosts } from "./hosts";
import {
  isEndfieldCredentialErrorCode,
  normalizeEndfieldPositionData,
  parseEndfieldPositionSocketError,
  parseEndfieldPositionSocketMessage,
  parseEndfieldSocketEnvelope
} from "./positionParser";
import { createMessageId, getSignature } from "./signature";
import type { EndfieldDeviceProfile, EndfieldPositionData, EndfieldProvider, WebSocketTokenData } from "./types";

const ENDFIELD_POSITION_SOCKET_HEARTBEAT_MS = 10_000;
const ENDFIELD_POSITION_SOCKET_AUTH_TIMEOUT_MS = 8_000;
const ENDFIELD_POSITION_SOCKET_RESUBSCRIBE_MS = 5_000;

type EndfieldPositionSocketHandlers = {
  onMessage?: (data: string | ArrayBuffer) => void;
  onClose?: () => void;
  onError?: () => void;
  onAuthenticated?: () => void;
  onSubscribed?: () => void;
};

export async function getEndfieldPosition(args: {
  provider: EndfieldProvider;
  roleId: string;
  serverId: number;
  cred: string;
  token: string;
  wsBaseUrl?: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<EndfieldPositionData> {
  try {
    return await getEndfieldPositionFromSocket(args);
  } catch (socketError) {
    const normalizedSocketError = socketError instanceof ApiError
      ? socketError
      : (socketError instanceof TypeError
          ? new ApiError(
            502,
            "ENDFIELD_POSITION_SOCKET_UNAVAILABLE",
            "Endfield realtime position socket was unavailable.",
            { phase: "socket setup" }
          )
          : null);
    const socketUnavailable = normalizedSocketError?.code === "ENDFIELD_POSITION_SOCKET_UNAVAILABLE"
      && normalizedSocketError.status >= 500;
    const socketDetails = normalizedSocketError?.details as { upstreamStatus?: unknown } | undefined;
    const upstreamStatus = Number(socketDetails?.upstreamStatus);
    const socketUpstreamUnavailable = normalizedSocketError?.code === "ENDFIELD_UPSTREAM_REJECTED"
      && (upstreamStatus === 408 || upstreamStatus === 429 || upstreamStatus >= 500);
    if (
      !normalizedSocketError
      || (
        !socketUnavailable
        && !socketUpstreamUnavailable
        && ![
          "ENDFIELD_POSITION_SOCKET_TIMEOUT",
          "ENDFIELD_POSITION_SOCKET_CLOSED",
          "ENDFIELD_POSITION_SOCKET_ERROR",
          "ENDFIELD_POSITION_SOCKET_SEND_FAILED",
          "ENDFIELD_POSITION_SOCKET_TOKEN_MISSING",
          "ENDFIELD_BAD_RESPONSE"
        ].includes(normalizedSocketError.code)
      )
    ) {
      throw socketError;
    }

    try {
      return await getEndfieldPositionHttpFallback(args);
    } catch (fallbackError) {
      if (fallbackError instanceof ApiError && fallbackError.status === 401) {
        throw fallbackError;
      }
      const socketErrorDetails = normalizedSocketError.details && typeof normalizedSocketError.details === "object"
        ? normalizedSocketError.details as Record<string, unknown>
        : {};
      throw new ApiError(normalizedSocketError.status, normalizedSocketError.code, normalizedSocketError.message, {
        ...socketErrorDetails,
        httpFallbackAttempted: true,
        httpFallbackStatus: fallbackError instanceof ApiError ? fallbackError.status : undefined,
        httpFallbackCode: fallbackError instanceof ApiError ? fallbackError.code : "FETCH_FAILED"
      });
    }
  }
}

export async function getEndfieldPositionHttpFallback(args: {
  provider: EndfieldProvider;
  roleId: string;
  serverId: number;
  cred: string;
  token: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<EndfieldPositionData> {
  const hosts = getEndfieldHosts(args.provider);
  const path = "/web/v1/game/endfield/map/me/position";
  const signPath = `${path}roleId=${args.roleId}&serverId=${args.serverId}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = await getSignature(signPath, timestamp, args.token);
  const query = new URLSearchParams({
    roleId: args.roleId,
    serverId: String(args.serverId)
  });
  const origin = args.provider === "skland"
    ? "https://game.skland.com"
    : "https://game.skport.com";

  const response = await fetch(`${buildUrl(hosts.baseUrl, path)}?${query.toString()}`, {
    method: "GET",
    headers: {
      accept: "*/*",
      cred: args.cred,
      origin,
      platform: "3",
      referer: `${origin}/`,
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      "sk-language": "en",
      ...buildDeviceHeaders(args.deviceProfile)
    }
  });

  const data = await parseApiEnvelope<EndfieldPositionData>(response, { positionRequest: true });
  const normalized = normalizeEndfieldPositionData(data);
  if (!normalized) {
    throw new ApiError(502, "ENDFIELD_BAD_RESPONSE", "Failed to parse upstream position response.");
  }
  return normalized;
}

export async function getEndfieldWebSocketToken(args: {
  provider: EndfieldProvider;
  cred: string;
  token: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<string> {
  const hosts = getEndfieldHosts(args.provider);
  const path = "/api/v1/websocket/token";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = await getSignature(path, timestamp, args.token, "");

  const response = await fetch(buildUrl(hosts.baseUrl, path), {
    method: "GET",
    headers: {
      accept: "*/*",
      cred: args.cred,
      platform: "3",
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      "sk-language": "en",
      ...buildDeviceHeaders(args.deviceProfile)
    }
  });

  const data = await parseApiEnvelope<WebSocketTokenData>(response);
  if (!data.token) {
    throw new ApiError(502, "ENDFIELD_POSITION_SOCKET_TOKEN_MISSING", "WebSocket token response did not include a token.");
  }
  return data.token;
}

function closeEndfieldSocket(socket: WebSocket, reason: string, code = 1011): void {
  try {
    socket.close(code, reason);
  } catch {
    // socket is already closed
  }
}

function trySendEndfieldPositionSocket(socket: WebSocket, payload: unknown): boolean {
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    closeEndfieldSocket(socket, "send failed");
    return false;
  }
}

export async function connectEndfieldPositionSocket(args: {
  provider: EndfieldProvider;
  roleId: string;
  serverId: number;
  cred: string;
  token: string;
  wsBaseUrl?: string;
  deviceProfile?: EndfieldDeviceProfile;
}, handlers: EndfieldPositionSocketHandlers): Promise<WebSocket> {
  const hosts = getEndfieldHosts(args.provider);
  const socketToken = await getEndfieldWebSocketToken({
    provider: args.provider,
    cred: args.cred,
    token: args.token,
    deviceProfile: args.deviceProfile
  });
  const path = "/ws/v1/game/endfield/map";
  const signPath = `${path}roleId=${args.roleId}&serverId=${args.serverId}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = await getSignature(signPath, timestamp, args.token);
  const query = new URLSearchParams({
    roleId: args.roleId,
    serverId: String(args.serverId)
  });
  const origin = args.provider === "skland"
    ? "https://game.skland.com"
    : "https://game.skport.com";

  const url = `${buildWebSocketHttpUrl(args.wsBaseUrl ?? hosts.wsBaseUrl, path)}?${query.toString()}`;
  const response = await fetch(url, {
    headers: {
      upgrade: "websocket",
      cred: args.cred,
      origin,
      platform: "3",
      referer: `${origin}/`,
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      "sk-language": "en",
      ...buildDeviceHeaders(args.deviceProfile)
    }
  });

  if (response.status !== 101 || !response.webSocket) {
    const detail = await response.text().catch(() => "");
    throw new ApiError(
      response.status === 401 || response.status === 403 ? 401 : 502,
      "ENDFIELD_POSITION_SOCKET_UNAVAILABLE",
      "Endfield realtime position socket was unavailable.",
      {
        upstreamStatus: response.status,
        url,
        detail: detail.slice(0, 240)
      }
    );
  }

  const socket = response.webSocket;
  socket.accept();

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  let resubscribeTimer: ReturnType<typeof setInterval> | undefined;
  let subscriptionSent = false;
  let lastPositionFrameAt = 0;

  const clearTimers = () => {
    if (authenticationTimer !== undefined) {
      clearTimeout(authenticationTimer);
      authenticationTimer = undefined;
    }
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (resubscribeTimer !== undefined) {
      clearInterval(resubscribeTimer);
      resubscribeTimer = undefined;
    }
  };

  const sendSubscription = () => {
    const sent = trySendEndfieldPositionSocket(socket, {
      type: 1011,
      data: {
        roleId: args.roleId,
        serverId: String(args.serverId)
      },
      msgId: createMessageId()
    });
    if (sent) {
      lastPositionFrameAt = Date.now();
    }
    return sent;
  };

  socket.addEventListener("message", (event) => {
    const data = event.data as string | ArrayBuffer;
    const message = parseEndfieldSocketEnvelope(data);

    if (message?.type === 1012) {
      lastPositionFrameAt = Date.now();
    }

    if (!subscriptionSent && message?.type === 2) {
      if (authenticationTimer !== undefined) {
        clearTimeout(authenticationTimer);
        authenticationTimer = undefined;
      }
      handlers.onAuthenticated?.();
      if (!sendSubscription()) {
        clearTimers();
        handlers.onError?.();
        return;
      }

      subscriptionSent = true;
      handlers.onSubscribed?.();
      if (!trySendEndfieldPositionSocket(socket, {
        type: 3,
        data: {},
        msgId: createMessageId()
      })) {
        clearTimers();
        handlers.onError?.();
        return;
      }

      heartbeat = setInterval(() => {
        if (!trySendEndfieldPositionSocket(socket, {
          type: 3,
          data: {},
          msgId: createMessageId()
        })) {
          clearTimers();
        }
      }, ENDFIELD_POSITION_SOCKET_HEARTBEAT_MS);

      resubscribeTimer = setInterval(() => {
        if (Date.now() - lastPositionFrameAt < ENDFIELD_POSITION_SOCKET_RESUBSCRIBE_MS) return;
        if (!sendSubscription()) {
          clearTimers();
          handlers.onError?.();
        }
      }, ENDFIELD_POSITION_SOCKET_RESUBSCRIBE_MS);
    }

    handlers.onMessage?.(data);
  });

  socket.addEventListener("close", () => {
    clearTimers();
    handlers.onClose?.();
  });

  socket.addEventListener("error", () => {
    clearTimers();
    handlers.onError?.();
  });

  authenticationTimer = setTimeout(() => {
    clearTimers();
    handlers.onError?.();
    closeEndfieldSocket(socket, "authentication timeout");
  }, ENDFIELD_POSITION_SOCKET_AUTH_TIMEOUT_MS);

  if (!trySendEndfieldPositionSocket(socket, {
    type: 1,
    data: { token: socketToken },
    msgId: createMessageId()
  })) {
    clearTimers();
    throw new ApiError(
      502,
      "ENDFIELD_POSITION_SOCKET_SEND_FAILED",
      "Endfield realtime position socket closed during authentication."
    );
  }

  return socket;
}

export async function getEndfieldPositionFromSocket(
  args: {
    provider: EndfieldProvider;
    roleId: string;
    serverId: number;
    cred: string;
    token: string;
    wsBaseUrl?: string;
    deviceProfile?: EndfieldDeviceProfile;
  },
  timeoutMs = 8_000
): Promise<EndfieldPositionData> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let authAckSeen = false;
    let subscriptionSent = false;
    const seenTypes = new Set<number>();
    const seenCodes = new Set<number>();

    const settle = (reason: string, callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (socket) closeEndfieldSocket(socket, reason, 1000);
      callback();
    };

    void connectEndfieldPositionSocket(args, {
      onAuthenticated: () => {
        authAckSeen = true;
      },
      onSubscribed: () => {
        subscriptionSent = true;
      },
      onMessage: (data) => {
        const envelope = parseEndfieldSocketEnvelope(data);
        if (envelope?.type !== undefined) {
          seenTypes.add(envelope.type);
        }

        const position = parseEndfieldPositionSocketMessage(data);
        if (position) {
          settle("position received", () => resolve(position));
          return;
        }

        const error = parseEndfieldPositionSocketError(data);
        if (error) {
          seenCodes.add(error.code);
          const credentialRejected = isEndfieldCredentialErrorCode(error.code);
          settle("position unavailable", () => {
            reject(new ApiError(
              401,
              credentialRejected ? "ENDFIELD_CREDENTIAL_REJECTED" : "ENDFIELD_POSITION_UNAVAILABLE",
              credentialRejected
                ? "Endfield credential was rejected."
                : "Player is not currently logged into the game or position is unavailable.",
              {
                provider: args.provider,
                upstreamCode: error.code,
                upstreamMessage: error.message,
                seenTypes: [...seenTypes]
              }
            ));
          });
        }
      },
      onClose: () => {
        settle("upstream closed", () => {
          reject(new ApiError(
            502,
            "ENDFIELD_POSITION_SOCKET_CLOSED",
            "Endfield realtime position socket closed before sending a position.",
            {
              provider: args.provider,
              seenTypes: [...seenTypes],
              seenCodes: [...seenCodes],
              authAckSeen,
              subscriptionSent
            }
          ));
        });
      },
      onError: () => {
        settle("upstream error", () => {
          reject(new ApiError(
            502,
            "ENDFIELD_POSITION_SOCKET_ERROR",
            "Endfield realtime position socket failed before sending a position.",
            {
              provider: args.provider,
              seenTypes: [...seenTypes],
              seenCodes: [...seenCodes],
              authAckSeen,
              subscriptionSent
            }
          ));
        });
      }
    })
      .then((connectedSocket) => {
        socket = connectedSocket;
        if (settled) {
          closeEndfieldSocket(connectedSocket, "request settled", 1000);
          return;
        }
        timeout = setTimeout(() => {
          settle("position timeout", () => {
            reject(new ApiError(
              504,
              "ENDFIELD_POSITION_SOCKET_TIMEOUT",
              "Timed out waiting for a parsable Endfield realtime position.",
              {
                provider: args.provider,
                seenTypes: [...seenTypes],
                seenCodes: [...seenCodes],
                authAckSeen,
                subscriptionSent
              }
            ));
          });
        }, timeoutMs);
      })
      .catch((error: unknown) => {
        settle("connection failed", () => reject(error));
      });
  });
}
