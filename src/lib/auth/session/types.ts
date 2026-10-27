import type { AuthUser } from "@/types/app";

export type ReadSessionInput = {
  cookie?: string;
  authorization?: string;
  accessToken?: string;
};

export type ReadSessionResult = { cookies: string[] } & (
  | { ok: true; user: AuthUser; requiresCookieConfirmation: boolean }
  // A failed read can carry cookies produced before the failure.
  // The caller emits them and rethrows the original error for normal error handling.
  | { ok: false; error: unknown }
);
