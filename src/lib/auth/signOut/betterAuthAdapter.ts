import { buildBetterAuthRequestHeaders, invokeBetterAuthHandler } from "@/lib/auth/betterAuth";
import type { Bindings } from "@/types/app";

import type { SignOutInput } from "./types";

export function invokeSignOut(env: Bindings, input: SignOutInput): Promise<Response> {
  const target = new URL(input.request.url);
  const publicPath = target.pathname;
  target.pathname = "/auth/v1/sign-out";
  const request = new Request(target.toString(), {
    method: input.request.method,
    headers: buildBetterAuthRequestHeaders(input.request),
    body: input.body,
  });
  return invokeBetterAuthHandler(env, request, {
    publicPath,
    authPath: "/sign-out",
    requestId: input.requestId,
  });
}
