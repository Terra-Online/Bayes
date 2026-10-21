import type { Context } from "hono";

import { ApiError } from "@/lib/errors";
import type { AppEnv } from "@/types/app";

export function requireUser(c: Context<AppEnv>) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  return user;
}
