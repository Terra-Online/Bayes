import { createMiddleware } from "hono/factory";

import { ApiError } from "@/lib/errors";
import type { AppEnv } from "@/types/app";

export const requireModerationUnlocked = createMiddleware<AppEnv>(async (c, next) => {
  const flag = (c.env.LOCK_MODERATION_ENDPOINTS ?? "true").trim().toLowerCase();
  if (!["0", "false", "off", "no"].includes(flag)) {
    throw new ApiError(
      503,
      "MODERATION_TEMPORARILY_DISABLED",
      "Moderation endpoints are temporarily disabled during stabilization.",
    );
  }
  await next();
});
