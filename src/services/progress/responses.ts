import { ApiError } from "../../lib/errors";

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
  if (error instanceof ApiError) {
    return jsonResponse(
      {
        code: error.code,
        message: error.message,
        details: error.details
      },
      { status: error.status }
    );
  }

  const message = error instanceof Error ? error.message : "Internal progress error.";
  return jsonResponse(
    {
      code: "PROGRESS_INTERNAL_ERROR",
      message
    },
    { status: 500 }
  );
}
