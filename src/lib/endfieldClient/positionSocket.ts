import { ApiError } from "../errors";
import { parseApiEnvelope } from "./envelope";
import { buildDeviceHeaders, buildUrl, buildWebSocketHttpUrl, getEndfieldHosts } from "./hosts";
import { parseEndfieldPositionSocketError, parseEndfieldPositionSocketMessage, parseEndfieldSocketEnvelope } from "./positionParser";
import { createMessageId, getSignature } from "./signature";
import type { EndfieldDeviceProfile, EndfieldPositionData, EndfieldProvider, WebSocketTokenData } from "./types";

const ENDFIELD_POSITION_SOCKET_HEARTBEAT_MS = 10_000;

export async function getEndfieldPosition(args: {
  provider: EndfieldProvider;
  roleId: string;
  serverId: number;
  cred: string;
  token: string;
  wsBaseUrl?: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<EndfieldPositionData> {
  return getEndfieldPositionFromSocket(args);
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

  const response = await fetch(`${buildUrl(hosts.baseUrl, path)}?${query.toString()}`, {
    method: "GET",
    headers: {
      cred: args.cred,
      platform: "3",
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      ...buildDeviceHeaders(args.deviceProfile)
    }
  });

  return parseApiEnvelope<EndfieldPositionData>(response, { positionRequest: true });
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

function closeEndfieldSocket(socket: WebSocket, reason: string): void {
  try {
    socket.close(1011, reason);
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
}): Promise<WebSocket> {
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

  response.webSocket.accept();
  if (!trySendEndfieldPositionSocket(response.webSocket, {
    type: 1,
    data: { token: socketToken },
    msgId: createMessageId()
  })) {
    throw new ApiError(
      502,
      "ENDFIELD_POSITION_SOCKET_SEND_FAILED",
      "Endfield realtime position socket closed during authentication."
    );
  }
  const heartbeat = setInterval(() => {
    if (!trySendEndfieldPositionSocket(response.webSocket!, {
      type: 3,
      data: {},
      msgId: createMessageId()
    })) {
      clearInterval(heartbeat);
    }
  }, ENDFIELD_POSITION_SOCKET_HEARTBEAT_MS);
  response.webSocket.addEventListener("message", (event) => {
    const message = parseEndfieldSocketEnvelope(event.data as string | ArrayBuffer);
    if (message?.type === 2) {
      if (!trySendEndfieldPositionSocket(response.webSocket!, {
        type: 1011,
        data: {
          roleId: args.roleId,
          serverId: String(args.serverId)
        },
        msgId: createMessageId()
      })) {
        clearInterval(heartbeat);
        return;
      }
      trySendEndfieldPositionSocket(response.webSocket!, {
        type: 3,
        data: {},
        msgId: createMessageId()
      });
    }
  });
  response.webSocket.addEventListener("close", () => clearInterval(heartbeat));
  response.webSocket.addEventListener("error", () => clearInterval(heartbeat));
  return response.webSocket;
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
  const socket = await connectEndfieldPositionSocket(args);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close(1000, "position received");
      } catch {
        // socket is already closed
      }
      callback();
    };
    const timeout = setTimeout(() => {
      settle(() => {
        reject(new ApiError(
          504,
          "ENDFIELD_POSITION_SOCKET_TIMEOUT",
          "Timed out waiting for a parsable Endfield realtime position."
        ));
      });
    }, timeoutMs);

    socket.addEventListener("message", (event) => {
      const position = parseEndfieldPositionSocketMessage(event.data as string | ArrayBuffer);
      if (position) {
        settle(() => resolve(position));
        return;
      }

      const error = parseEndfieldPositionSocketError(event.data as string | ArrayBuffer);
      if (error) {
        settle(() => {
          reject(new ApiError(
            401,
            "ENDFIELD_POSITION_UNAVAILABLE",
            "Player is not currently logged into the game or position is unavailable.",
            {
              upstreamCode: error.code,
              upstreamMessage: error.message
            }
          ));
        });
      }
    });

    socket.addEventListener("close", () => {
      settle(() => {
        reject(new ApiError(
          502,
          "ENDFIELD_POSITION_SOCKET_CLOSED",
          "Endfield realtime position socket closed before sending a position."
        ));
      });
    });

    socket.addEventListener("error", () => {
      settle(() => {
        reject(new ApiError(
          502,
          "ENDFIELD_POSITION_SOCKET_ERROR",
          "Endfield realtime position socket failed before sending a position."
        ));
      });
    });
  });
}
