import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { commentTranslationSchema } from "@/routes/schema/uploads";
import { translateVisibleComments } from "@/services/ugc/translation/comments";
import type { AppEnv } from "@/types/app";

import { assertActiveUser } from "./middleware";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().post(
    "/comments/translations",
    rateLimit("public"),
    async (c) => {
      const parsed = commentTranslationSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid translation payload.",
          parsed.error.flatten(),
        );
      }

      if (parsed.data.cachedOnly !== true) {
        await assertActiveUser(c);
      }

      return c.json(await translateVisibleComments(c.env, parsed.data));
    },
  );
}
