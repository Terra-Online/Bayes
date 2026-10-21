import { toSerializableError } from "@/lib/auth/errors";
import { ApiError } from "@/lib/errors";
import { hmacServiceIdentifier } from "@/lib/serviceIdentity";
import { resolveRequestAuthUser } from "@/middleware/auth";
import { toApiError } from "@/middleware/error-handler";
import type { Bindings } from "@/types/app";

const NOTIFICATION_LIVE_PATH = "/notify/v1/live";

export async function proxyNotificationLive(
  env: Bindings,
  request: Request,
  uid: string,
  clientId: string,
): Promise<Response> {
  const objectId = env.OEM_NOTIFICATION_DO.idFromName(uid);
  const stub = env.OEM_NOTIFICATION_DO.get(objectId);
  const headers = new Headers(request.headers);
  headers.set("x-oem-notify-user", uid);
  headers.set("x-oem-notify-client-id", clientId);

  return stub.fetch("https://notify.internal/connect", {
    method: "GET",
    headers,
  });
}

type LiveStage = "auth" | "rate_limit" | "notification_do";
type LiveDiagnostics = {
  stage: LiveStage;
  elapsedMs: number;
  stageDurationsMs: Partial<Record<LiveStage, number>>;
};

function liveUpgradeError(
  error: unknown,
  requestId: string,
  diagnostics: LiveDiagnostics,
): Response {
  const apiError = toApiError(error);
  if (apiError.status >= 500) {
    console.error("notification live upgrade failed", {
      requestId,
      code: apiError.code,
      ...diagnostics,
      error: toSerializableError(error),
    });
  }
  return new Response(
    JSON.stringify({
      code: apiError.code,
      message: apiError.message,
      details: apiError.details,
      requestId,
    }),
    {
      status: apiError.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": requestId,
        "cache-control": "private, no-store",
        ...(apiError.status === 503 ? { "retry-after": "5" } : {}),
      },
    },
  );
}

/**
 * Keep the WebSocket 101 response out of Hono's response reconstruction path.
 * The Cloudflare WebSocket handle is carried on the Response itself and must
 * reach the runtime unchanged.
 */
export async function handleNotificationLiveUpgrade(
  request: Request,
  env: Bindings,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.pathname !== NOTIFICATION_LIVE_PATH ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    return null;
  }

  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const startedAt = Date.now();
  let stage: LiveStage = "auth";
  let stageStartedAt = startedAt;
  const stageDurationsMs: Partial<Record<LiveStage, number>> = {};
  const beginStage = (next: LiveStage) => {
    stageDurationsMs[stage] = Date.now() - stageStartedAt;
    stage = next;
    stageStartedAt = Date.now();
  };
  try {
    const user = await resolveRequestAuthUser(env, request);
    beginStage("rate_limit");
    if (user.role !== "r") {
      const requestIp = request.headers.get("cf-connecting-ip") ?? "anonymous";
      const key = await hmacServiceIdentifier(env, "cf-rate:notify-live", `ip:${requestIp}`);
      const result = await env.OEM_AUTH_RATE_LIMIT.limit({ key });
      if (!result.success) {
        throw new ApiError(429, "RATE_LIMITED", "Too many notification live connection attempts.");
      }
    }

    beginStage("notification_do");
    const response = await proxyNotificationLive(
      env,
      request,
      user.uid,
      url.searchParams.get("clientId")?.trim() || crypto.randomUUID(),
    );
    stageDurationsMs[stage] = Date.now() - stageStartedAt;
    if (response.status >= 500) {
      console.error("notification live upgrade failed", {
        requestId,
        stage,
        elapsedMs: Date.now() - startedAt,
        stageDurationsMs,
        upstreamStatus: response.status,
      });
    }
    return response;
  } catch (error) {
    stageDurationsMs[stage] = Date.now() - stageStartedAt;
    return liveUpgradeError(error, requestId, {
      stage,
      elapsedMs: Date.now() - startedAt,
      stageDurationsMs,
    });
  }
}
