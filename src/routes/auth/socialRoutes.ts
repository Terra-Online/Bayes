import { Hono } from "hono";
import { z } from "zod";

import { rateLimit } from "@/middleware/rate-limit";
import { readJsonObject } from "@/routes/input";
import { operation } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/auth";
import { beginSocialLogin } from "@/services/auth/loginViaSocial";
import { completeOAuthCallback, handleOAuthError } from "@/services/auth/oauthCallback";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post(
      "/sign-in/social",
      operation("signInWithSocial", "Accounts", "Begin social sign-in", {
        errors: [400, 403, 429, 503],
        body: docs.socialLoginSchema,
        response: docs.socialLoginResponseSchema,
        description:
          "Requires a trusted frontend Origin; establishes a browser proof cookie. Follow the returned URL using the same browser.",
      }),
      rateLimit("public"),
      async (c) => {
        const payload = await readJsonObject(c.req);
        return beginSocialLogin(c.env, {
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
          payload,
        });
      },
    )
    .on(
      ["GET", "POST", "OPTIONS"],
      "/callback/*",
      operation("oauthCallback", "Accounts", "Complete a provider callback", {
        operationId: (route) => `oauthCallback${route.method}`,
        description: "Provider-owned callback parameters and form fields are forwarded unchanged.",
        responses: {
          302: {
            description: "OAuth callback redirect",
            headers: { Location: { schema: { type: "string" } } },
          },
          200: { description: "Provider callback response" },
        },
      }),
      rateLimit("public"),
      async (c) => {
        return completeOAuthCallback(c.env, {
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    )
    .get(
      "/error",
      operation("getAuthError", "Accounts", "Redirect an authentication error", {
        errors: [429, 503],
        query: z.object({ error: z.string().optional() }),
        responses: {
          302: {
            description: "Trusted frontend error redirect",
            headers: { Location: { schema: { type: "string" } } },
          },
        },
      }),
      rateLimit("public"),
      async (c) => {
        return handleOAuthError(c.env, {
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    );
}
