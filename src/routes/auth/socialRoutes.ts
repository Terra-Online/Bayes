import { Hono } from "hono";

import { rateLimit } from "@/middleware/rate-limit";
import { readJsonObject } from "@/routes/input";
import { beginSocialLogin } from "@/services/auth/loginViaSocial";
import { completeOAuthCallback, handleOAuthError } from "@/services/auth/oauthCallback";
import type { AppEnv } from "@/types/app";

import { authRequestInfo, authResponse } from "./honoAdapter";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/sign-in/social", rateLimit("public"), async (c) => {
      const payload = await readJsonObject(c.req);
      return authResponse(
        c,
        await beginSocialLogin(c.env, {
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
          payload,
        }),
      );
    })
    .on(["GET", "POST", "OPTIONS"], "/callback/*", rateLimit("public"), async (c) => {
      return authResponse(
        c,
        await completeOAuthCallback(c.env, {
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
          body: c.req.raw.body === null ? null : await c.req.arrayBuffer(),
        }),
      );
    })
    .get("/error", rateLimit("public"), async (c) => {
      return authResponse(
        c,
        await handleOAuthError(c.env, {
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
          body: null,
        }),
      );
    });
}
