import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";

import { toSerializableError } from "@/lib/auth/errors";
import { toApiError } from "@/lib/errors";
import type { AppEnv } from "@/types/app";

export { toApiError } from "@/lib/errors";

function errorJson<E extends AppEnv<{ requestId?: string }>>(
  c: Context<E>,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return c.newResponse(
    JSON.stringify({
      code,
      message,
      details,
      requestId: c.get("requestId"),
      error: {
        code,
        message,
        details,
        requestId: c.get("requestId"),
      },
    }),
    {
      status: status as StatusCode,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        ...(status === 503 ? { "retry-after": "5" } : {}),
      },
    },
  );
}

export function onAppError<E extends AppEnv<{ requestId?: string }>>(
  error: unknown,
  c: Context<E>,
) {
  const apiError = toApiError(error);
  if (apiError.status >= 500) {
    console.error("request failed", {
      requestId: c.get("requestId"),
      code: apiError.code,
      message: apiError.message,
      details: apiError.details,
      rawError: toSerializableError(error),
    });
  }
  return errorJson(c, apiError.status, apiError.code, apiError.message, apiError.details);
}
