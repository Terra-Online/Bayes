import { Hono } from "hono";

import { rateLimit } from "@/middleware/rate-limit";
import { readJsonObject } from "@/routes/input";
import { beginSocialLogin } from "@/services/auth/loginViaSocial";
import { completeOAuthCallback, handleOAuthError } from "@/services/auth/oauthCallback";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/sign-in/social", rateLimit("public"), async (c) => {
      const payload = await readJsonObject(c.req);
      return beginSocialLogin(c.env, {
        raw_request: c.req.raw,
        requestId: c.get("requestId"),
        payload,
      });
    })
    .on(["GET", "POST", "OPTIONS"], "/callback/*", rateLimit("public"), async (c) => {
      return completeOAuthCallback(c.env, {
        raw_request: c.req.raw,
        requestId: c.get("requestId"),
      });
    })
    .get("/error", rateLimit("public"), async (c) => {
      return handleOAuthError(c.env, {
        raw_request: c.req.raw,
        requestId: c.get("requestId"),
      });
    });
}
