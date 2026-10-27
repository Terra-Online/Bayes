import { createCookieGetter } from "better-auth/cookies";

import { resolveAuthorization, type AuthCredentials } from "@/services/auth/contract/credentials";
import type { Bindings } from "@/types/app";

import { authCookieOptions } from "./origins";

// This is only a presence check. Better Auth verifies each credential.
const sessionCookieNames = new Map<string, readonly string[]>();

function getSessionCookieNames(env: Bindings): readonly string[] {
  const baseUrl = env.BETTER_AUTH_URL?.trim() ?? "";
  const cached = sessionCookieNames.get(baseUrl);
  if (cached) {
    return cached;
  }

  const options = authCookieOptions(env);
  const currentName = createCookieGetter(options)("session_token").name;
  const legacyName = createCookieGetter({
    ...options,
    advanced: { ...options.advanced, cookiePrefix: "better-auth" },
  })("session_token").name;
  const names = currentName === legacyName ? [currentName] : [currentName, legacyName];
  sessionCookieNames.set(baseUrl, names);
  return names;
}

function cookieHeaderHasName(header: string, name: string): boolean {
  let start = 0;
  while (start < header.length) {
    const separator = header.indexOf(";", start);
    const end = separator === -1 ? header.length : separator;
    let cursor = start;
    while (cursor < end && header.charCodeAt(cursor) <= 0x20) {
      cursor += 1;
    }
    if (header.startsWith(name, cursor) && header.charCodeAt(cursor + name.length) === 61) {
      return true;
    }
    if (separator === -1) {
      break;
    }
    start = separator + 1;
  }
  return false;
}

export function hasSessionCredentials(env: Bindings, credentials: AuthCredentials): boolean {
  if (resolveAuthorization(credentials)?.trim()) {
    return true;
  }
  const raw = credentials.cookie;
  if (!raw) {
    return false;
  }
  return getSessionCookieNames(env).some((name) => cookieHeaderHasName(raw, name));
}
