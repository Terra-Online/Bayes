import { invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import type { Bindings } from "@/types/app";

import type { LoginViaPasswordInput } from "./types";

export function signInWithPassword(env: Bindings, input: LoginViaPasswordInput): Promise<Response> {
  return invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
    jsonBody: input.payload,
  });
}
