import { ApiError } from "../../lib/errors";
import type { AppContext } from "./types";

export const POSITION_STREAM_RECONNECT_MS = 1_000;

export function shouldIncludeBinding(c: AppContext): boolean {
  const value = c.req.query("binding") ?? c.req.query("includeBinding");
  return value === "1" || value === "true";
}

export function requireUser(c: AppContext) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  return user;
}

export function serializeLocatorError(error: unknown) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    status: 500,
    code: "LOCATOR_STREAM_ERROR",
    message: error instanceof Error ? error.message : "Locator stream failed."
  };
}
