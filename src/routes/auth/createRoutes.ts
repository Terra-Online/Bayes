import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().on(
    ["GET", "POST", "OPTIONS"],
    "/*",
    async () => {
      throw new ApiError(404, "NOT_FOUND", "Not found.");
    },
  );
}
