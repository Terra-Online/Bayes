import { ApiError } from "@/lib/errors";
import {
  createCredentialRecoveryScope,
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
import type { Bindings } from "@/types/app";

import { prepareLocatorAccess, type LocatorIdentity } from "./access";
import { getPositionCacheKey, writePositionCache } from "./cache";
import { positionReconnectDelay } from "./reconnect";
import type { PositionCacheEntry } from "./types";

export type LocatorStreamEvent =
  | { type: "status"; status: "connecting" | "connected" | "reconnecting"; reason?: string }
  | {
      type: "position";
      data: PositionCacheEntry["data"];
      binding: DecryptedBinding["publicBinding"];
    }
  | { type: "error"; error: unknown };

type PositionStreamCallbacks = {
  onEvent(event: LocatorStreamEvent): void;
  onClose(code: number, reason: string): void;
  schedule(task: Promise<unknown>): void;
};

export type PositionStreamCloseReason =
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

export function createPositionStream(
  input: { resolveIdentity(): Promise<LocatorIdentity> },
  env: Bindings,
  callbacks: PositionStreamCallbacks,
) {
  const recoveryScope = createCredentialRecoveryScope();
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
    callbacks.onClose(code, closeText);
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

  const emit = (payload: LocatorStreamEvent) => {
    if (closed) {
      return;
    }
    try {
      callbacks.onEvent(payload);
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
        emit({
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
          wsBaseUrl: env.ENDFIELD_WS_BASE_URL,
          signal: lifetime.signal,
          deviceProfile: currentBinding.deviceProfile,
        },
        {
          onSubscribed: () => {
            if (closed || generation !== upstreamGeneration) {
              return;
            }
            upstreamSubscribedAt ??= Date.now();
            emit({
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
              const rejection = new ApiError(deviceRejected ? 502 : 401, code, message, {
                upstreamCode: error.code,
                upstreamMessage: error.message,
              });
              const errorPayload: LocatorStreamEvent = { type: "error", error: rejection };
              if ((credentialRejected && !credentialExpired) || deviceRejected) {
                upstreamGeneration += 1;
                const recoveryGeneration = upstreamGeneration;
                emit({
                  type: "status",
                  status: "reconnecting",
                  reason: deviceRejected ? "refreshing device profile" : "refreshing credentials",
                });
                upstream?.close(1000, "refreshing credentials");
                upstream = undefined;
                const recovery = recoverBindingCredentials(
                  {
                    uid: currentUserUid,
                    rejectedCredentials: currentBinding,
                    rejection,
                  },
                  { env, recoveryScope },
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
                      emit(errorPayload);
                    }
                  });
                callbacks.schedule(recovery);
                return;
              }
              emit(errorPayload);
              return;
            }

            const position = parseEndfieldPositionSocketMessage(data);
            if (!position) {
              return;
            }
            writePositionCache(env, getPositionCacheKey(currentUserUid, currentBinding.binding), {
              data: position,
              refreshedAt: Date.now(),
            });
            emit({
              type: "position",
              data: position,
              binding: currentBinding.publicBinding,
            });
          },
          onClose: (termination) => {
            if (!closed && generation === upstreamGeneration) {
              upstreamGeneration += 1;
              emit({
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
              emit({
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
        emit({
          type: "error",
          error,
        });
        return;
      }
      if (isAutoRefreshableEndfieldError(error)) {
        const refreshed = await recoverBindingCredentials(
          { uid: currentUserUid, rejectedCredentials: currentBinding, rejection: error },
          { env, recoveryScope },
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
          emit({
            type: "error",
            error,
          });
          return;
        }
      }
      emit({
        type: "error",
        error,
      });
      scheduleReconnect("bridge-failed");
    }
  };

  const initializeStream = async () => {
    if (closed) {
      return;
    }
    try {
      const identity = await input.resolveIdentity();
      const resolved = await prepareLocatorAccess(identity, env);
      if (closed) {
        return;
      }
      userUid = resolved.uid;
      binding = resolved.binding;
      void bridgeUpstream(false);
    } catch (error) {
      emit({
        type: "error",
        error,
      });
      close(error instanceof ApiError && error.status === 401 ? 1008 : 1011, "stream-unavailable");
    }
  };

  return {
    close,
    start() {
      emit({ type: "status", status: "connecting" });
      return initializeStream();
    },
  };
}
