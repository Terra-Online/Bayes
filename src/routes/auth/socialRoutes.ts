import type { Hono } from "hono";
import { ApiError } from "../../lib/errors";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types/app";
import {
  applyDefaultSocialCallbackUrls,
  attachSessionExchangeCode,
  getProviderFromCallbackPath,
  toSafeTrustedUrlLog,
} from "./callbacks";
import { resolveTrustedRequestOrigin } from "./frontendOrigins";
import type { ForwardToAuthJsonPath, ForwardToAuthRawRequest } from "./types";

export function registerSocialAuthRoutes(
  app: Hono<AppEnv>,
  deps: {
    forwardToAuthJsonPath: ForwardToAuthJsonPath;
    forwardToAuthRawRequest: ForwardToAuthRawRequest;
  },
) {
  app.post("/sign-in/social", rateLimit("public"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return deps.forwardToAuthRawRequest(c);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.");
    }

    const nextBody = applyDefaultSocialCallbackUrls(c, body as Record<string, unknown>);
    const provider = typeof nextBody.provider === "string" ? nextBody.provider : "unknown";
    console.warn("[auth][social-sign-in] forwarding", {
      provider,
      requestSignUp: typeof nextBody.requestSignUp === "boolean" ? nextBody.requestSignUp : null,
      disableRedirect: typeof nextBody.disableRedirect === "boolean" ? nextBody.disableRedirect : null,
      requestOrigin: resolveTrustedRequestOrigin(c),
      callbackURL: toSafeTrustedUrlLog(
        c,
        typeof nextBody.callbackURL === "string" ? nextBody.callbackURL : null,
      ),
      newUserCallbackURL: toSafeTrustedUrlLog(
        c,
        typeof nextBody.newUserCallbackURL === "string" ? nextBody.newUserCallbackURL : null,
      ),
      errorCallbackURL: toSafeTrustedUrlLog(
        c,
        typeof nextBody.errorCallbackURL === "string" ? nextBody.errorCallbackURL : null,
      ),
    });

    return deps.forwardToAuthJsonPath(
      c,
      "/sign-in/social",
      nextBody,
    );
  });

  app.get("/reset-password/*", rateLimit("public"), async (c) => {
    return deps.forwardToAuthRawRequest(c);
  });

  app.on(["GET", "POST", "OPTIONS"], "/callback/*", rateLimit("public"), async (c) => {
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
  });

  app.get("/error", rateLimit("public"), async (c) => {
    return deps.forwardToAuthRawRequest(c);
  });
}
