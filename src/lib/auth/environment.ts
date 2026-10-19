import type { Bindings } from "../../types/app";

// These are the bindings/configuration values captured by Better Auth or by its
// email/social provider callbacks. Do not compare the whole Worker env: an
// unrelated binding wrapper may be recreated for every request and would throw
// away completed authentication values for no behavioral reason.
const AUTH_ENVIRONMENT_KEYS = [
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
  "OEM_ID_MAILS"
] as const satisfies readonly (keyof Bindings)[];

// Compare the database and auth-dependent bindings by identity/value. Keep the
// snapshot private: it includes secrets and must never be logged or used as a
// cache key.
export function sameAuthEnvironment(snapshot: Bindings, env: Bindings): boolean {
  if (snapshot.DB !== env.DB) return false;
  return AUTH_ENVIRONMENT_KEYS.every((key) => snapshot[key] === env[key]);
}
