import { Hono } from "hono";
import { ApiError } from "../../lib/errors";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types/app";
import { forwardToAuthJsonPath } from "./forwarding";
import {
  parseTrustedFrontendOrigins,
  resolveTrustedCallbackUrl,
  resolveTrustedRequestOrigin,
} from "./frontendOrigins";
import { toSafeTrustedUrlLog } from "./callbacks";
import type { AuthRouteContext } from "./types";

const LEGACY_SOCIAL_PROVIDERS = new Set(["discord", "google", "github"]);

type SocialSignInResponse = {
  url?: unknown;
};

function readBooleanQuery(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  return undefined;
}

function readLocalePath(raw: string | undefined): string {
  if (!raw) {
    return "/";
  }

  const locale = raw.trim();
  return /^[A-Za-z]{2}(?:-[A-Za-z]{2})?$/.test(locale) ? `/${locale}` : "/";
}

function resolveLegacyCallbackUrl(c: AuthRouteContext): string {
  const trustedOrigin = resolveTrustedRequestOrigin(c) ?? parseTrustedFrontendOrigins(c)[0];
  if (!trustedOrigin) {
    throw new ApiError(400, "INVALID_CALLBACK_URL", "No trusted frontend origin is configured.");
  }

  const fallback = new URL(readLocalePath(c.req.query("locale")), trustedOrigin).toString();
  return (
    resolveTrustedCallbackUrl(c, c.req.query("callbackURL"), trustedOrigin)
    ?? resolveTrustedCallbackUrl(c, c.req.query("redirectTo"), trustedOrigin)
    ?? resolveTrustedCallbackUrl(c, c.req.query("redirect"), trustedOrigin)
    ?? fallback
  );
}

async function readSocialAuthorizationUrl(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.clone().json()) as SocialSignInResponse;
    return typeof parsed.url === "string" && parsed.url.length > 0 ? parsed.url : null;
  } catch {
    return null;
  }
}

export function createLegacySocialAuthRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/:provider/redirect", rateLimit("public"), async (c) => {
    const provider = c.req.param("provider").trim().toLowerCase();
    if (!LEGACY_SOCIAL_PROVIDERS.has(provider)) {
      throw new ApiError(404, "PROVIDER_NOT_FOUND", "Social provider not found.");
    }

    const callbackURL = resolveLegacyCallbackUrl(c);
    const requestSignUp = readBooleanQuery(c.req.query("requestSignUp"));
    const body: Record<string, unknown> = {
      provider,
      callbackURL,
      newUserCallbackURL:
        resolveTrustedCallbackUrl(c, c.req.query("newUserCallbackURL"), new URL(callbackURL).origin)
        ?? callbackURL,
      errorCallbackURL:
        resolveTrustedCallbackUrl(c, c.req.query("errorCallbackURL"), new URL(callbackURL).origin)
        ?? callbackURL,
      disableRedirect: true,
    };

    if (requestSignUp !== undefined) {
      body.requestSignUp = requestSignUp;
    }

    console.warn("[auth][legacy-social-redirect] forwarding", {
      provider,
      requestSignUp: requestSignUp ?? null,
      requestOrigin: resolveTrustedRequestOrigin(c),
      callbackURL: toSafeTrustedUrlLog(c, callbackURL),
    });

    const response = await forwardToAuthJsonPath(c, "/sign-in/social", body);
    if (!response.ok) {
      return response;
    }

    const authorizationUrl = await readSocialAuthorizationUrl(response);
    if (!authorizationUrl) {
      throw new ApiError(500, "AUTH_FLOW_FAILED", "Missing social authorization URL.");
    }

    return c.redirect(authorizationUrl, 302);
  });

  return app;
}
