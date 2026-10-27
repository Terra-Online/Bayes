import {
  buildBetterAuthRequestHeaders,
  invokeBetterAuthHandler,
  readBetterAuthResponseData,
  type BetterAuthRequestInfo,
  type BetterAuthResponseData,
} from "@/services/auth/betterAuth";
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

async function invokeAccountOperation(
  env: Bindings,
  input: { request: BetterAuthRequestInfo; requestId: string },
  authPath: "/link-social" | "/unlink-account",
  body: LinkAccountBody | { accountId: string },
): Promise<BetterAuthResponseData> {
  const target = new URL(input.request.url);
  const publicPath = target.pathname;
  // Better Auth dispatches these operations under its configured /auth/v1 base path.
  target.pathname = `/auth/v1${authPath}`;
  const request = new Request(target.toString(), {
    method: "POST",
    headers: buildBetterAuthRequestHeaders(input.request, { forceJson: true }),
    body: JSON.stringify(body),
  });
  const response = await invokeBetterAuthHandler(env, request, {
    publicPath,
    authPath,
    requestId: input.requestId,
  });
  return readBetterAuthResponseData(response);
}

export function beginAccountLink(
  env: Bindings,
  input: BeginLinkLoginMethodInput,
): Promise<BetterAuthResponseData> {
  const callbackUrls = applyDefaultSocialCallbackUrls(env, input.request, {
    callbackURL: input.callbackURL,
    errorCallbackURL: input.errorCallbackURL,
  });
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
): Promise<BetterAuthResponseData> {
  // Better Auth's accountId parameter requires auth_accounts.id, not the provider's external ID.
  // Its handler checks session age, account ownership and the last-account restriction.
  return invokeAccountOperation(env, input, "/unlink-account", { accountId: localAccountId });
}
