import { Hono } from "hono";

import {
  followPasswordResetLink,
  previewPasswordReset,
  requestPasswordReset,
  resetPassword,
} from "@/lib/auth/resetPassword";
import { rateLimit } from "@/middleware/rate-limit";
import {
  requestPasswordResetSchema,
  resetPasswordPreviewSchema,
  resetPasswordSchema,
} from "@/routes/schema/auth";
import type { AppEnv } from "@/types/app";

import { authRequestInfo, authResponse } from "./honoAdapter";
import { parseAuthInput, readJsonBody } from "./input";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/forget-password", rateLimit("reset-send"), async (c) => {
      const input = parseAuthInput(requestPasswordResetSchema, await readJsonBody(c.req));

      return authResponse(
        c,
        await requestPasswordReset(c.env, {
          ...input,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .post("/reset-password", rateLimit("public"), async (c) => {
      const input = parseAuthInput(resetPasswordSchema, await readJsonBody(c.req));

      return authResponse(
        c,
        await resetPassword(c.env, {
          ...input,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .get("/reset-password-preview", rateLimit("public"), async (c) => {
      const input = parseAuthInput(resetPasswordPreviewSchema, {
        token: c.req.query("token"),
      });

      return c.json(await previewPasswordReset(c.env, input));
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
