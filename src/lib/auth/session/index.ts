// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. HTTP objects stay inside this module.

import { hasSessionCredentials } from "@/lib/auth/betterAuth";
import { resolveAuthorization, type AuthCredentials } from "@/lib/auth/contract/credentials";
import { invalidateAuthUserCache, resolveAuthUser } from "@/lib/auth/identity";
import { ApiError } from "@/lib/errors";
import type { Bindings } from "@/types/app";

import { createBetterAuthSessionAdapter } from "./betterAuthAdapter";
import type { ReadSessionResult } from "./types";

export type { ReadSessionResult } from "./types";

export async function readSession(
  env: Bindings,
  credentials: AuthCredentials,
): Promise<ReadSessionResult> {
  const cookies: string[] = [];
  try {
    if (!hasSessionCredentials(env, credentials)) {
      throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
    }
    const adapter = createBetterAuthSessionAdapter(env, credentials);
    const result = await adapter.readFreshSession();
    cookies.push(...result.cookies);
    if (!result.session) {
      invalidateAuthUserCache(env, credentials);
      if (resolveAuthorization(credentials)?.trim().toLowerCase().startsWith("bearer ")) {
        throw new ApiError(401, "TOKEN_EXPIRED", "Token is expired, missing, or invalid.");
      }
      throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
    }

    // Use the freshly verified identity so a warm cache cannot authenticate a revoked session.
    const user = await resolveAuthUser(env, credentials, {
      uid: result.session.user.id,
      email: result.session.user.email,
      displayName: result.session.user.name,
    });
    cookies.push(...(await adapter.createMigrationCookies(result.session.session)));
    return {
      ok: true,
      user,
      cookies,
      requiresCookieConfirmation: adapter.requiresCookieConfirmation,
    };
  } catch (error) {
    return { ok: false, error, cookies };
  }
}
