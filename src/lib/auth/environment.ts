import type { Bindings } from "@/types/app";

// These are the bindings/configuration values captured by Better Auth or by its
// email/social provider callbacks. Do not compare the whole Worker env: an
// unrelated binding wrapper may be recreated for every request and would throw
// away completed authentication values for no behavioral reason.
const AUTH_CACHE_ENVIRONMENT_KEYS = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "TRUSTED_ORIGINS",
  "CORS_ORIGINS",
  "SESSION_TTL_SECONDS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "EMAIL_TEMPLATE_DEFAULT_LOCALE",
  "EMAIL_PROVIDER_MODE",
  "EMAIL_PRIMARY_PROVIDER",
  "EMAIL_FALLBACK_ENABLED",
  "EMAIL_RESEND_DAILY_LIMIT",
  "EMAIL_FROM_EMAIL",
  "EMAIL_FROM_NAME",
  "RESEND_AUTH_KEY",
  "RESEND_FROM_EMAIL",
  "RESEND_FROM_NAME",
] as const satisfies readonly (keyof Bindings)[];

const AUTH_ENVIRONMENT_KEYS = [...AUTH_CACHE_ENVIRONMENT_KEYS, "OEM_ID_MAILS"] as const;

// OEM_ID_MAILS is excluded from the completed identity cache scope. It is an
// object binding whose wrapper may change between invocations, and it is only
// used when sending email; it does not change session validation or identity.

// Compare the database and auth-dependent bindings by identity/value. Keep the
// snapshot private: it includes secrets and must never be logged or used as a
// cache key.
function sameEnvironment(
  snapshot: Bindings,
  env: Bindings,
  keys: readonly (keyof Bindings)[],
): boolean {
  if (snapshot.DB !== env.DB) {
    return false;
  }
  return keys.every((key) => snapshot[key] === env[key]);
}

export function sameAuthEnvironment(snapshot: Bindings, env: Bindings): boolean {
  return sameEnvironment(snapshot, env, AUTH_ENVIRONMENT_KEYS);
}

export function sameAuthCacheEnvironment(snapshot: Bindings, env: Bindings): boolean {
  return sameEnvironment(snapshot, env, AUTH_CACHE_ENVIRONMENT_KEYS);
}
