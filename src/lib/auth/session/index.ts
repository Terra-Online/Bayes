// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. HTTP objects stay inside this module.

import { hasSessionCredentials } from "@/lib/auth/betterAuth";
import { invalidateAuthUserCache, resolveAuthUser } from "@/lib/auth/identity";
import { ApiError } from "@/lib/errors";
import type { Bindings } from "@/types/app";

import { buildSessionCredentialHeaders, createBetterAuthSessionAdapter } from "./betterAuthAdapter";
import type { ReadSessionInput, ReadSessionResult } from "./types";

export type { ReadSessionInput, ReadSessionResult } from "./types";

export async function readSession(
  env: Bindings,
  input: ReadSessionInput,
): Promise<ReadSessionResult> {
  const cookies: string[] = [];
  try {
    const authHeaders = buildSessionCredentialHeaders(input);
    if (!hasSessionCredentials(env, authHeaders)) {
      throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
    }
    const adapter = createBetterAuthSessionAdapter(env, authHeaders);
    const result = await adapter.readFreshSession();
    cookies.push(...result.cookies);
    if (!result.session) {
      invalidateAuthUserCache(authHeaders, env);
      if (authHeaders.get("authorization")?.trim().toLowerCase().startsWith("bearer ")) {
        throw new ApiError(401, "TOKEN_EXPIRED", "Token is expired, missing, or invalid.");
      }
      throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
    }

    // Use the freshly verified identity so a warm cache cannot authenticate a revoked session.
    const user = await resolveAuthUser(env, authHeaders, {
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
