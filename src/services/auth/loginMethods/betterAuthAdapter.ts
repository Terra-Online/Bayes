import { invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import {
  applyDefaultSocialCallbackUrls,
  type SocialCallbackUrls,
} from "@/services/auth/rules/frontendOrigins";
import type { Bindings } from "@/types/app";

import type { BeginLinkLoginMethodInput, UnlinkLoginMethodInput } from "./types";

type LinkAccountBody = Partial<SocialCallbackUrls> & {
  provider: BeginLinkLoginMethodInput["provider"];
  disableRedirect: boolean;
};

function invokeAccountOperation(
  env: Bindings,
  input: { raw_request: Request; requestId: string },
  authPath: "/link-social" | "/unlink-account",
  body: LinkAccountBody | { accountId: string },
): Promise<Response> {
  return invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
    authPath,
    jsonBody: body,
  });
}

export function beginAccountLink(
  env: Bindings,
  input: BeginLinkLoginMethodInput,
): Promise<Response> {
  const callbackUrls = applyDefaultSocialCallbackUrls(
    env,
    {
      origin: input.raw_request.headers.get("origin") ?? undefined,
      referer: input.raw_request.headers.get("referer") ?? undefined,
    },
    {
      callbackURL: input.callbackURL,
      errorCallbackURL: input.errorCallbackURL,
    },
  );
  const body: LinkAccountBody = {
    provider: input.provider,
    callbackURL: input.callbackURL,
    errorCallbackURL: input.errorCallbackURL,
    disableRedirect: input.disableRedirect ?? true,
    ...(callbackUrls ?? {}),
  };
  // Better Auth stores the linking user in OAuth state and completes binding in the callback.
  return invokeAccountOperation(env, input, "/link-social", body);
}

export function unlinkAccount(
  env: Bindings,
  input: UnlinkLoginMethodInput,
  localAccountId: string,
): Promise<Response> {
  // Better Auth's accountId parameter requires auth_accounts.id, not the provider's external ID.
  // Its handler checks session age, account ownership and the last-account restriction.
  return invokeAccountOperation(env, input, "/unlink-account", { accountId: localAccountId });
}
