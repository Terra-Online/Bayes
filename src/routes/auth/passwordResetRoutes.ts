import { Hono } from "hono";

import {
  followPasswordResetLink,
  previewPasswordReset,
  requestPasswordReset,
  resetPassword,
} from "@/lib/auth/resetPassword";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import {
  requestPasswordResetSchema,
  resetPasswordPreviewSchema,
  resetPasswordSchema,
} from "@/routes/schema/auth";
import type { AppEnv } from "@/types/app";

import { authRequestInfo, authResponse } from "./honoAdapter";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/forget-password", rateLimit("reset-send"), async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
      }

      const parsed = requestPasswordResetSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
      }

      return authResponse(
        c,
        await requestPasswordReset(c.env, {
          ...parsed.data,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .post("/reset-password", rateLimit("public"), async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
      }

      const parsed = resetPasswordSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
      }

      return authResponse(
        c,
        await resetPassword(c.env, {
          ...parsed.data,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .get("/reset-password-preview", rateLimit("public"), async (c) => {
      const parsed = resetPasswordPreviewSchema.safeParse({
        token: c.req.query("token"),
      });
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
      }

      return c.json(await previewPasswordReset(c.env, parsed.data));
    })
    .get("/reset-password/*", rateLimit("public"), async (c) => {
      return authResponse(
        c,
        await followPasswordResetLink(c.env, {
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    });
}
