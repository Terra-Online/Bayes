import { invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import { normalizeEmail } from "@/services/auth/contract/email";
import type { Bindings } from "@/types/app";

export type LoginViaPasswordInput = {
  // The route parses JSON first. This module reads only this request's URL and headers.
  raw_request: Request;
  requestId: string;
  // This invocation owns the parsed object. Email normalization updates it in place.
  // Better Auth validates the fields and retains its public validation errors.
  payload: Record<string, unknown>;
};

export function loginViaPassword(env: Bindings, input: LoginViaPasswordInput): Promise<Response> {
  const owned_payload = input.payload;
  if (typeof owned_payload.email === "string") {
    owned_payload.email = normalizeEmail(owned_payload.email);
  }
  return invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
    jsonBody: owned_payload,
  });
}
