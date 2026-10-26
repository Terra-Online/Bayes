import { Hono } from "hono";

import { createAuth } from "@/lib/auth/betterAuth";
import { AUTH_EXCHANGE_CHALLENGE_PARAM, createOAuthExchangeProof } from "@/lib/auth/browserSession";
import {
  applyDefaultSocialCallbackUrls,
  parseTrustedFrontendOrigins,
  resolveTrustedRequestOrigin,
} from "@/lib/auth/rules/frontendOrigins";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import type { AppEnv } from "@/types/app";

import {
  attachSessionExchangeCode,
  getProviderFromCallbackPath,
  toSafeTrustedUrlLog,
} from "./callbacks";
import { forwardToAuthJsonPath, forwardToAuthRawRequest } from "./forwarding";
import { readJsonObject } from "./input";
import type { ForwardToAuthJsonPath, ForwardToAuthRawRequest } from "./types";

export function createRoutes(
  deps: {
    forwardToAuthJsonPath: ForwardToAuthJsonPath;
    forwardToAuthRawRequest: ForwardToAuthRawRequest;
  } = { forwardToAuthJsonPath, forwardToAuthRawRequest },
) {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/sign-in/social", rateLimit("public"), async (c) => {
      const payload = await readJsonObject(c.req);

      const requestOrigin = c.req.header("origin");
      const requestOriginInfo = { origin: requestOrigin, referer: c.req.header("referer") };
      const callbackInput = {
        callbackURL: typeof payload.callbackURL === "string" ? payload.callbackURL : undefined,
        newUserCallbackURL:
          typeof payload.newUserCallbackURL === "string" ? payload.newUserCallbackURL : undefined,
        errorCallbackURL:
          typeof payload.errorCallbackURL === "string" ? payload.errorCallbackURL : undefined,
      };
      const provider = typeof payload.provider === "string" ? payload.provider : "unknown";
      const requestSignUp =
        typeof payload.requestSignUp === "boolean" ? payload.requestSignUp : null;
      const disableRedirect =
        typeof payload.disableRedirect === "boolean" ? payload.disableRedirect : null;
      const callbackUrls =
        applyDefaultSocialCallbackUrls(c.env, requestOriginInfo, callbackInput) ?? callbackInput;
      if (!requestOrigin || !parseTrustedFrontendOrigins(c.env).includes(requestOrigin)) {
        throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "A trusted frontend origin is required.");
      }
      const proof = await createOAuthExchangeProof(createAuth(c.env));
      for (const key of ["callbackURL", "newUserCallbackURL"] as const) {
        const rawUrl = callbackUrls[key];
        if (rawUrl === undefined) {
          continue;
        }
        const callback = new URL(rawUrl);
        callback.searchParams.set(AUTH_EXCHANGE_CHALLENGE_PARAM, proof.challenge);
        callbackUrls[key] = callback.toString();
      }
      const nextBody: Record<string, unknown> = { ...payload, ...callbackUrls };
      console.warn("[auth][social-sign-in] forwarding", {
        provider,
        requestSignUp,
        disableRedirect,
        requestOrigin: resolveTrustedRequestOrigin(c.env, requestOriginInfo),
        callbackURL: toSafeTrustedUrlLog(c, callbackUrls.callbackURL ?? null),
        newUserCallbackURL: toSafeTrustedUrlLog(c, callbackUrls.newUserCallbackURL ?? null),
        errorCallbackURL: toSafeTrustedUrlLog(c, callbackUrls.errorCallbackURL ?? null),
      });

      const response = await deps.forwardToAuthJsonPath(c, "/sign-in/social", nextBody);
      if (response.ok) {
        response.headers.append("Set-Cookie", proof.cookie);
      }
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    })
    .on(["GET", "POST", "OPTIONS"], "/callback/*", rateLimit("public"), async (c) => {
      console.warn("[auth][oauth-callback] incoming", {
        provider: getProviderFromCallbackPath(c.req.path),
        method: c.req.method,
        hasState: Boolean(c.req.query("state")),
        hasCode: Boolean(c.req.query("code")),
        hasError: Boolean(c.req.query("error")),
      });
      const response = await deps.forwardToAuthRawRequest(c);
      const location = response.headers.get("location");
      console.warn("[auth][oauth-callback] response", {
        provider: getProviderFromCallbackPath(c.req.path),
        status: response.status,
        hasLocation: Boolean(location),
        location: toSafeTrustedUrlLog(c, location),
        hasSetCookie: Boolean(response.headers.get("set-cookie")),
        hasSetAuthToken: Boolean(response.headers.get("set-auth-token")),
      });
      return attachSessionExchangeCode(c, response);
    })
    .get("/error", rateLimit("public"), async (c) => {
      return deps.forwardToAuthRawRequest(c);
    });
}
