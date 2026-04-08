import type { Context } from "hono";
import { ApiError, isApiError } from "../lib/errors";
import type { AppEnv } from "../types/app";

function errorJson(c: Context<AppEnv>, status: number, code: string, message: string, details?: unknown) {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        details,
        requestId: c.get("requestId")
      }
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    }
  );
}

export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error;
  }
  return new ApiError(500, "INTERNAL_ERROR", "Internal server error.");
}

export function onAppError(error: unknown, c: Context<AppEnv>) {
  const apiError = toApiError(error);
  if (apiError.status >= 500) {
    console.error("request failed", {
      requestId: c.get("requestId"),
      code: apiError.code,
      message: apiError.message,
      details: apiError.details
    });
  }
  return errorJson(c, apiError.status, apiError.code, apiError.message, apiError.details);
}
