import { Hono } from "hono";
import type { z } from "zod";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { operation, optionalSessionSecurity } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/uploads";
import { commentTranslationSchema } from "@/routes/schema/uploads";
import { translateVisibleComments } from "@/services/ugc/translation/comments";
import type { AppEnv } from "@/types/app";

import { assertActiveUser } from "./middleware";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().post(
    "/comments/translations",
    operation("translateComments", "Comments", "Read or request visible comment translations", {
      errors: [429, 503],
      security: optionalSessionSecurity,
      body: docs.commentTranslationSchema,
      response: docs.translationsResponseSchema,
      description:
        "cachedOnly=true permits public cached reads; otherwise an active user is required. Inspect each item for errors.",
    }),
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

      return c.json(
        (await translateVisibleComments(c.env, parsed.data)) satisfies z.output<
          typeof docs.translationsResponseSchema
        >,
      );
    },
  );
}
