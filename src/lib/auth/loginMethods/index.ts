// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. The internal adapter handles
// Better Auth's Request, Headers and Response objects.

import type { BetterAuthResponseData } from "@/lib/auth/betterAuth";
import { ApiError } from "@/lib/errors";
import type { Bindings } from "@/types/app";

import { findUserProviderAccounts, listUserAccounts } from "./accountRepository";
import { beginAccountLink, unlinkAccount } from "./betterAuthAdapter";
import type {
  BeginLinkLoginMethodInput,
  CurrentLoginMethodUser,
  LoginMethod,
  UnlinkLoginMethodInput,
} from "./types";

export type {
  BeginLinkLoginMethodInput,
  CurrentLoginMethodUser,
  LoginMethod,
  UnlinkLoginMethodInput,
} from "./types";

export async function listLoginMethods(
  env: Bindings,
  input: CurrentLoginMethodUser,
): Promise<LoginMethod[]> {
  const rows = await listUserAccounts(env.DB, input.currentUserId);
  const accounts = rows.map((account) => ({
    provider: account.providerId === "credential" ? "email" : account.providerId,
    linkedAt: account.createdAt,
    verified: account.providerId === "credential" ? true : undefined,
  }));
  const uniqueProviders = new Set(accounts.map((account) => account.provider));
  // The list reports provider diversity. Better Auth separately authorizes each unlink operation.
  return accounts.map((account) => ({ ...account, unlinkable: uniqueProviders.size > 1 }));
}

export function beginLinkLoginMethod(
  env: Bindings,
  input: BeginLinkLoginMethodInput,
): Promise<BetterAuthResponseData> {
  return beginAccountLink(env, input);
}

export async function unlinkLoginMethod(
  env: Bindings,
  input: UnlinkLoginMethodInput,
): Promise<BetterAuthResponseData> {
  const providerId = input.provider === "email" ? "credential" : input.provider;
  const accounts = await findUserProviderAccounts(env.DB, input.currentUserId, providerId);
  if (accounts.length === 0) {
    throw new ApiError(
      400,
      "ACCOUNT_NOT_LINKED",
      "This login method is not linked to your account.",
    );
  }
  if (accounts.length > 1) {
    throw new ApiError(409, "PROVIDER_CONFLICT", "Multiple accounts use this login method.");
  }
  return unlinkAccount(env, input, accounts[0]!.id);
}
