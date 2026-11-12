import { Hono } from "hono";
import { z } from "zod";

import { rateLimit } from "@/middleware/rate-limit";
import { parseInput, readJsonBody } from "@/routes/input";
import { operation } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/auth";
import {
  requestPasswordResetSchema,
  resetPasswordPreviewSchema,
  resetPasswordSchema,
} from "@/routes/schema/auth";
import {
  followPasswordResetLink,
  previewPasswordReset,
  requestPasswordReset,
  resetPassword,
} from "@/services/auth/resetPassword";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post(
      "/forget-password",
      operation("requestPasswordReset", "Accounts", "Request a password-reset link", {
        errors: [400, 429, 503],
        body: docs.requestPasswordResetSchema,
        response: z.object({ status: z.boolean(), message: z.string().optional() }),
      }),
      rateLimit("reset-send"),
      async (c) => {
        const input = parseInput(requestPasswordResetSchema, await readJsonBody(c.req));

        return requestPasswordReset(c.env, {
          ...input,
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    )
    .post(
      "/reset-password",
      operation("resetPassword", "Accounts", "Set a new password using a reset token", {
        errors: [400, 429, 503],
        body: docs.resetPasswordSchema,
        response: z.object({ status: z.boolean() }),
      }),
      rateLimit("public"),
      async (c) => {
        const input = parseInput(resetPasswordSchema, await readJsonBody(c.req));

        return resetPassword(c.env, {
          ...input,
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    )
    .get(
      "/reset-password-preview",
      operation("previewPasswordReset", "Accounts", "Inspect a password-reset token", {
        errors: [400, 429, 503],
        query: docs.resetPasswordPreviewSchema,
        response: docs.passwordResetPreviewResponseSchema,
      }),
      rateLimit("public"),
      async (c) => {
        const input = parseInput(resetPasswordPreviewSchema, {
          token: c.req.query("token"),
        });

        return c.json(
          (await previewPasswordReset(c.env, input)) satisfies z.output<
            typeof docs.passwordResetPreviewResponseSchema
          >,
        );
      },
    )
    .get(
      "/reset-password/*",
      operation("followPasswordResetLink", "Accounts", "Follow a password-reset link", {
        errors: [400, 429, 503],
        parameters: [{ in: "query", name: "callbackURL", schema: { type: "string" } }],
        responses: {
          302: {
            description: "Redirect to the reset page",
            headers: { Location: { schema: { type: "string" } } },
          },
        },
      }),
      rateLimit("public"),
      async (c) => {
        return followPasswordResetLink(c.env, {
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    );
}
