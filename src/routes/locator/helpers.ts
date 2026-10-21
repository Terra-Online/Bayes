import { ApiError } from "@/lib/errors";
import type { AppContext } from "@/routes/binding/types";

export function shouldIncludeBinding(c: AppContext): boolean {
  const value = c.req.query("binding") ?? c.req.query("includeBinding");
  return value === "1" || value === "true";
}

export function serializeLocatorError(error: unknown, requestId?: string) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      ...(requestId ? { requestId } : {}),
    };
  }

  return {
    status: 500,
    code: "LOCATOR_STREAM_ERROR",
    message: error instanceof Error ? error.message : "Locator stream failed.",
    ...(requestId ? { requestId } : {}),
  };
}
