import { Hono } from "hono";
import { z } from "zod";

import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { parseInput } from "@/routes/input";
import { operation, sessionSecurity } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/auth";
import { linkAccountSchema, unlinkAccountSchema } from "@/routes/schema/auth";
import {
  beginLinkLoginMethod,
  listLoginMethods,
  unlinkLoginMethod,
} from "@/services/auth/loginMethods";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .get(
      "/list-accounts",
      operation("listLoginMethods", "Accounts", "List linked login methods", {
        errors: [429, 503],
        security: sessionSecurity,
        response: docs.loginMethodsResponseSchema,
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");

        const accounts = await listLoginMethods(c.env, { currentUserId: user.uid });
        const response = c.json({ accounts } satisfies z.output<
          typeof docs.loginMethodsResponseSchema
        >);
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      },
    )
    .post(
      "/link-social",
      operation("linkSocialAccount", "Accounts", "Link a social login method", {
        errors: [400, 409, 429, 503],
        security: sessionSecurity,
        body: docs.linkAccountSchema,
        response: docs.socialLoginResponseSchema,
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const input = parseInput(
          linkAccountSchema,
          await c.req.json().catch(() => null),
          "Invalid account link payload.",
        );

        return beginLinkLoginMethod(c.env, {
          ...input,
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    )
    .post(
      "/unlink-account",
      operation("unlinkAccount", "Accounts", "Unlink a login method", {
        errors: [400, 409, 429, 503],
        security: sessionSecurity,
        body: docs.unlinkAccountSchema,
        response: z.object({ status: z.boolean() }),
        description: "The last available login method cannot be unlinked.",
      }),
      requireAuth,
      rateLimit("auth"),
      async (c) => {
        const input = parseInput(
          unlinkAccountSchema,
          await c.req.json().catch(() => null),
          "Invalid account unlink payload.",
        );

        const user = c.get("authUser");
        return unlinkLoginMethod(c.env, {
          ...input,
          currentUserId: user.uid,
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    );
}
