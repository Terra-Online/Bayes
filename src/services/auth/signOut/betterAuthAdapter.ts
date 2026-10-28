import { invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import type { Bindings } from "@/types/app";

import type { SignOutInput } from "./types";

export function invokeSignOut(env: Bindings, input: SignOutInput): Promise<Response> {
  return invokeBetterAuthHandler(env, input.raw_request, { requestId: input.requestId });
}
