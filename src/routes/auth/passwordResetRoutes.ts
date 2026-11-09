import { Hono } from "hono";

import { rateLimit } from "@/middleware/rate-limit";
import { parseInput, readJsonBody } from "@/routes/input";
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
    .post("/forget-password", rateLimit("reset-send"), async (c) => {
      const input = parseInput(requestPasswordResetSchema, await readJsonBody(c.req));

      return requestPasswordReset(c.env, {
        ...input,
        raw_request: c.req.raw,
        requestId: c.get("requestId"),
      });
    })
    .post("/reset-password", rateLimit("public"), async (c) => {
      const input = parseInput(resetPasswordSchema, await readJsonBody(c.req));

      return resetPassword(c.env, {
        ...input,
        raw_request: c.req.raw,
        requestId: c.get("requestId"),
      });
    })
    .get("/reset-password-preview", rateLimit("public"), async (c) => {
      const input = parseInput(resetPasswordPreviewSchema, {
        token: c.req.query("token"),
      });

      return c.json(await previewPasswordReset(c.env, input));
    })
    .get("/reset-password/*", rateLimit("public"), async (c) => {
      return followPasswordResetLink(c.env, {
        raw_request: c.req.raw,
        requestId: c.get("requestId"),
      });
    });
}
