import { ApiError } from "@/lib/errors";

import { parseApiEnvelope } from "./envelope";
import { buildDeviceHeaders, buildUrl, buildWebSocketHttpUrl, getEndfieldHosts } from "./hosts";
import {
  isEndfieldCredentialErrorCode,
  isEndfieldDeviceErrorCode,
  normalizeEndfieldPositionData,
  parseEndfieldPositionSocketError,
  parseEndfieldPositionSocketMessage,
  parseEndfieldSocketEnvelope,
} from "./positionParser";
import { createMessageId, getEndfieldTimestamp, getSignature } from "./signature";
import type {
  EndfieldDeviceProfile,
  EndfieldPositionData,
  EndfieldProvider,
  WebSocketTokenData,
} from "./types";

const ENDFIELD_POSITION_SOCKET_HEARTBEAT_MS = 10_000;
const ENDFIELD_POSITION_SOCKET_AUTH_TIMEOUT_MS = 8_000;
const ENDFIELD_POSITION_SOCKET_RESUBSCRIBE_MS = 5_000;

type EndfieldCredentialRequest = {
  provider: EndfieldProvider;
  cred: string;
  token: string;
  deviceProfile?: EndfieldDeviceProfile;
  signal?: AbortSignal;
};

type EndfieldPositionRequest = EndfieldCredentialRequest & {
  roleId: string;
  serverId: number;
  wsBaseUrl?: string;
};

export type EndfieldPositionConnection = {
  close(code?: number, reason?: string): void;
};

export type EndfieldPositionTermination = {
  kind: "remote-close" | "socket-error" | "send-failed" | "authentication-timeout";
  phase: "authenticating" | "subscribed";
  code?: number;
  lifetimeMs: number;
};

type EndfieldPositionSocketHandlers = {
  onMessage?: (data: string | ArrayBuffer) => void;
  onClose?: (termination: EndfieldPositionTermination) => void;
  onError?: (termination: EndfieldPositionTermination) => void;
  onAuthenticated?: () => void;
  onSubscribed?: () => void;
};

export async function getEndfieldPosition(
  args: EndfieldPositionRequest,
): Promise<EndfieldPositionData> {
  try {
    return await getEndfieldPositionHttpFallback(args);
  } catch (httpError) {
    args.signal?.throwIfAborted();
    if (
      httpError instanceof ApiError &&
      (httpError.status < 500 || httpError.code === "ENDFIELD_DEVICE_REJECTED")
    ) {
      throw httpError;
    }
    try {
      return await getEndfieldPositionFromSocket(args);
    } catch (socketError) {
      args.signal?.throwIfAborted();
      if (socketError instanceof ApiError && socketError.status === 401) {
        throw socketError;
      }
      const httpDetails =
        httpError instanceof ApiError && httpError.details && typeof httpError.details === "object"
          ? (httpError.details as Record<string, unknown>)
          : {};
      throw new ApiError(
        502,
        "ENDFIELD_POSITION_UPSTREAM_UNAVAILABLE",
        "Endfield position upstream was unavailable.",
        {
          ...httpDetails,
          httpCode: httpError instanceof ApiError ? httpError.code : "FETCH_FAILED",
          socketCode: socketError instanceof ApiError ? socketError.code : "FETCH_FAILED",
        },
      );
    }
  }
}

export async function getEndfieldPositionHttpFallback(
  args: EndfieldPositionRequest,
): Promise<EndfieldPositionData> {
  const hosts = getEndfieldHosts(args.provider);
  const path = "/web/v1/game/endfield/map/me/position";
  const signPath = `${path}roleId=${args.roleId}&serverId=${args.serverId}`;
  const timestamp = getEndfieldTimestamp();
  const sign = await getSignature(
    signPath,
    timestamp,
    args.token,
    "",
    args.deviceProfile?.deviceId ?? "",
  );
  const query = new URLSearchParams({
    roleId: args.roleId,
    serverId: String(args.serverId),
  });
  const origin = args.provider === "skland" ? "https://game.skland.com" : "https://game.skport.com";

  const response = await fetch(`${buildUrl(hosts.baseUrl, path)}?${query.toString()}`, {
    method: "GET",
    signal: args.signal,
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
      ...buildDeviceHeaders(args.deviceProfile),
    },
  });

  const data = await parseApiEnvelope<EndfieldPositionData>(response, { positionRequest: true });
  const normalized = normalizeEndfieldPositionData(data);
  if (!normalized) {
    throw new ApiError(502, "ENDFIELD_BAD_RESPONSE", "Failed to parse upstream position response.");
  }
  return normalized;
}

export async function getEndfieldWebSocketToken(args: EndfieldCredentialRequest): Promise<string> {
  const hosts = getEndfieldHosts(args.provider);
  const path = "/api/v1/websocket/token";
  const timestamp = getEndfieldTimestamp();
  const sign = await getSignature(
    path,
    timestamp,
    args.token,
    "",
    args.deviceProfile?.deviceId ?? "",
  );

  const response = await fetch(buildUrl(hosts.baseUrl, path), {
    method: "GET",
    signal: args.signal,
    headers: {
      accept: "*/*",
      cred: args.cred,
      platform: "3",
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      "sk-language": "en",
      ...buildDeviceHeaders(args.deviceProfile),
    },
  });

  const data = await parseApiEnvelope<WebSocketTokenData>(response);
  if (!data.token) {
    throw new ApiError(
      502,
      "ENDFIELD_POSITION_SOCKET_TOKEN_MISSING",
      "WebSocket token response did not include a token.",
    );
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

export async function connectEndfieldPositionSocket(
  args: EndfieldPositionRequest,
  handlers: EndfieldPositionSocketHandlers,
): Promise<EndfieldPositionConnection> {
  args.signal?.throwIfAborted();
  const hosts = getEndfieldHosts(args.provider);
  const socketToken = await getEndfieldWebSocketToken(args);
  args.signal?.throwIfAborted();
  const path = "/ws/v1/game/endfield/map";
  const signPath = `${path}roleId=${args.roleId}&serverId=${args.serverId}`;
  const timestamp = getEndfieldTimestamp();
  const sign = await getSignature(
    signPath,
    timestamp,
    args.token,
    "",
    args.deviceProfile?.deviceId ?? "",
  );
  const query = new URLSearchParams({ roleId: args.roleId, serverId: String(args.serverId) });
  const origin = args.provider === "skland" ? "https://game.skland.com" : "https://game.skport.com";
  const url = `${buildWebSocketHttpUrl(args.wsBaseUrl ?? hosts.wsBaseUrl, path)}?${query}`;
  const response = await fetch(url, {
    signal: args.signal,
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
      ...buildDeviceHeaders(args.deviceProfile),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    const detail = await response.text().catch(() => "");
    args.signal?.throwIfAborted();
    throw new ApiError(
      response.status === 401 || response.status === 403 ? 401 : 502,
      "ENDFIELD_POSITION_SOCKET_UNAVAILABLE",
      "Endfield realtime position socket was unavailable.",
      { upstreamStatus: response.status, url, detail: detail.slice(0, 240) },
    );
  }

  const socket = response.webSocket;
  socket.accept();
  const connectedAt = Date.now();
  let closed = false;
  let phase: EndfieldPositionTermination["phase"] = "authenticating";
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  let resubscribeTimer: ReturnType<typeof setInterval> | undefined;
  let subscriptionSent = false;
  let lastPositionFrameAt = 0;

  const cleanup = () => {
    clearTimeout(authenticationTimer);
    clearInterval(heartbeat);
    clearInterval(resubscribeTimer);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
    args.signal?.removeEventListener("abort", onAbort);
  };
  const close = (code = 1000, reason = "closed") => {
    if (closed) {
      return;
    }
    closed = true;
    cleanup();
    closeEndfieldSocket(socket, reason, code);
  };
  const termination = (
    kind: EndfieldPositionTermination["kind"],
    code?: number,
  ): EndfieldPositionTermination => ({
    kind,
    phase,
    ...(code === undefined ? {} : { code }),
    lifetimeMs: Date.now() - connectedAt,
  });
  const onClose = (event: Event) => {
    if (closed) {
      return;
    }
    closed = true;
    cleanup();
    const code = Number((event as CloseEvent).code);
    handlers.onClose?.(
      termination("remote-close", Number.isFinite(code) && code > 0 ? code : undefined),
    );
  };
  const fail = (
    kind: Extract<
      EndfieldPositionTermination["kind"],
      "socket-error" | "send-failed" | "authentication-timeout"
    >,
    reason: string,
  ) => {
    if (closed) {
      return;
    }
    closed = true;
    cleanup();
    closeEndfieldSocket(socket, reason, 1011);
    handlers.onError?.(termination(kind, 1011));
  };
  const onError = () => fail("socket-error", "upstream error");
  const onAbort = () => close(1000, "request canceled");
  const send = (payload: unknown): boolean => {
    if (closed) {
      return false;
    }
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      fail("send-failed", "upstream error");
      return false;
    }
  };
  const sendSubscription = () => {
    const sent = send({
      type: 1011,
      data: { roleId: args.roleId, serverId: String(args.serverId) },
      msgId: createMessageId(),
    });
    if (sent) {
      lastPositionFrameAt = Date.now();
    }
    return sent;
  };
  const sendHeartbeat = () => send({ type: 3, data: {}, msgId: createMessageId() });
  const onMessage = (event: MessageEvent) => {
    const data = event.data as string | ArrayBuffer;
    const message = parseEndfieldSocketEnvelope(data);
    if (message?.type === 1012) {
      lastPositionFrameAt = Date.now();
    }
    if (!subscriptionSent && message?.type === 2) {
      clearTimeout(authenticationTimer);
      handlers.onAuthenticated?.();
      if (!sendSubscription()) {
        return;
      }
      subscriptionSent = true;
      phase = "subscribed";
      handlers.onSubscribed?.();
      if (!sendHeartbeat()) {
        return;
      }
      heartbeat = setInterval(sendHeartbeat, ENDFIELD_POSITION_SOCKET_HEARTBEAT_MS);
      resubscribeTimer = setInterval(() => {
        if (Date.now() - lastPositionFrameAt >= ENDFIELD_POSITION_SOCKET_RESUBSCRIBE_MS) {
          sendSubscription();
        }
      }, ENDFIELD_POSITION_SOCKET_RESUBSCRIBE_MS);
    }
    if (!closed) {
      handlers.onMessage?.(data);
    }
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  args.signal?.addEventListener("abort", onAbort, { once: true });
  if (args.signal?.aborted) {
    onAbort();
    args.signal.throwIfAborted();
  }
  authenticationTimer = setTimeout(() => {
    fail("authentication-timeout", "authentication timeout");
  }, ENDFIELD_POSITION_SOCKET_AUTH_TIMEOUT_MS);
  if (!send({ type: 1, data: { token: socketToken }, msgId: createMessageId() })) {
    throw new ApiError(
      502,
      "ENDFIELD_POSITION_SOCKET_SEND_FAILED",
      "Endfield realtime position socket closed during authentication.",
    );
  }
  return { close };
}

export async function getEndfieldPositionFromSocket(
  args: EndfieldPositionRequest,
  timeoutMs = 8_000,
): Promise<EndfieldPositionData> {
  args.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const signal = args.signal
      ? AbortSignal.any([controller.signal, args.signal])
      : controller.signal;
    let socket: EndfieldPositionConnection | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let authAckSeen = false;
    let subscriptionSent = false;
    const seenTypes = new Set<number>();
    const seenCodes = new Set<number>();

    const settle = (reason: string, callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      args.signal?.removeEventListener("abort", onAbort);
      controller.abort();
      socket?.close(1000, reason);
      callback();
    };

    const onAbort = () => settle("request canceled", () => reject(args.signal!.reason));
    args.signal?.addEventListener("abort", onAbort, { once: true });
    void connectEndfieldPositionSocket(
      { ...args, signal },
      {
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
            const deviceRejected = isEndfieldDeviceErrorCode(error.code);
            settle("position unavailable", () => {
              let code = "ENDFIELD_POSITION_UNAVAILABLE";
              let message =
                "Player is not currently logged into the game or position is unavailable.";
              if (deviceRejected) {
                code = "ENDFIELD_DEVICE_REJECTED";
                message = error.message ?? "Endfield device information was rejected.";
              } else if (credentialRejected) {
                code = "ENDFIELD_CREDENTIAL_REJECTED";
                message = "Endfield credential was rejected.";
              }
              reject(
                new ApiError(deviceRejected ? 502 : 401, code, message, {
                  provider: args.provider,
                  upstreamCode: error.code,
                  upstreamMessage: error.message,
                  seenTypes: [...seenTypes],
                }),
              );
            });
          }
        },
        onClose: () => {
          settle("upstream closed", () => {
            reject(
              new ApiError(
                502,
                "ENDFIELD_POSITION_SOCKET_CLOSED",
                "Endfield realtime position socket closed before sending a position.",
                {
                  provider: args.provider,
                  seenTypes: [...seenTypes],
                  seenCodes: [...seenCodes],
                  authAckSeen,
                  subscriptionSent,
                },
              ),
            );
          });
        },
        onError: () => {
          settle("upstream error", () => {
            reject(
              new ApiError(
                502,
                "ENDFIELD_POSITION_SOCKET_ERROR",
                "Endfield realtime position socket failed before sending a position.",
                {
                  provider: args.provider,
                  seenTypes: [...seenTypes],
                  seenCodes: [...seenCodes],
                  authAckSeen,
                  subscriptionSent,
                },
              ),
            );
          });
        },
      },
    )
      .then((connectedSocket) => {
        socket = connectedSocket;
        if (settled) {
          connectedSocket.close(1000, "request settled");
          return;
        }
        timeout = setTimeout(() => {
          settle("position timeout", () => {
            reject(
              new ApiError(
                504,
                "ENDFIELD_POSITION_SOCKET_TIMEOUT",
                "Timed out waiting for a parsable Endfield realtime position.",
                {
                  provider: args.provider,
                  seenTypes: [...seenTypes],
                  seenCodes: [...seenCodes],
                  authAckSeen,
                  subscriptionSent,
                },
              ),
            );
          });
        }, timeoutMs);
      })
      .catch((error: unknown) => {
        settle("connection failed", () => reject(error));
      });
  });
}
