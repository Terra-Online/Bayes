import { ApiError } from "../../lib/errors";
import { toApiError } from "../../middleware/error-handler";

export function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {})
    }
  });
}

export function errorResponse(error: unknown): Response {
  const apiError = toApiError(error);
  if (error instanceof ApiError || apiError.status !== 500) {
    return jsonResponse(
      {
        code: apiError.code,
        message: apiError.message,
        details: apiError.details
      },
      {
        status: apiError.status,
        headers: {
          "cache-control": "private, no-store",
          ...(apiError.status === 503 ? { "retry-after": "5" } : {})
        }
      }
    );
  }

  return jsonResponse(
    {
      code: "PROGRESS_INTERNAL_ERROR",
      message: "Internal progress error."
    },
    { status: 500, headers: { "cache-control": "private, no-store" } }
  );
}
