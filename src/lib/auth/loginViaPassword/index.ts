// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. The internal adapter handles
// Better Auth's Request, Headers and Response objects.

import type { BetterAuthResponseData } from "@/lib/auth/betterAuth";
import { normalizeEmail } from "@/lib/auth/contract/email";
import type { Bindings } from "@/types/app";

import { signInWithPassword } from "./betterAuthAdapter";
import type { LoginViaPasswordInput } from "./types";

export type { LoginViaPasswordInput } from "./types";

export function loginViaPassword(
  env: Bindings,
  input: LoginViaPasswordInput,
): Promise<BetterAuthResponseData> {
  return signInWithPassword(env, {
    ...input,
    email: typeof input.email === "string" ? normalizeEmail(input.email) : input.email,
  });
}
