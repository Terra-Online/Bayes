import type { BetterAuthRequestInfo } from "@/services/auth/betterAuth";

export type LoginViaPasswordInput = {
  // Better Auth validates these fields and returns their public validation errors.
  // The route validates JSON syntax and the top-level object before calling this module.
  email: unknown;
  password: unknown;
  rememberMe?: unknown;
  callbackURL?: unknown;
  // Better Auth's origin middleware also validates these redirect fields.
  redirectTo?: unknown;
  errorCallbackURL?: unknown;
  newUserCallbackURL?: unknown;
  request: BetterAuthRequestInfo;
  requestId: string;
};
