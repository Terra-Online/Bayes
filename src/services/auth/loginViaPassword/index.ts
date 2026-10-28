import { normalizeEmail } from "@/services/auth/contract/email";
import type { Bindings } from "@/types/app";

import { signInWithPassword } from "./betterAuthAdapter";
import type { LoginViaPasswordInput } from "./types";

export type { LoginViaPasswordInput } from "./types";

export function loginViaPassword(env: Bindings, input: LoginViaPasswordInput): Promise<Response> {
  if (typeof input.payload.email === "string") {
    input.payload.email = normalizeEmail(input.payload.email);
  }
  return signInWithPassword(env, input);
}
