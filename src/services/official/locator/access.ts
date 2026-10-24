import { ensureUserProfile } from "@/repositories/users";
import { readBindingCredentials } from "@/services/official/auth/credentials";
import type { Bindings } from "@/types/app";

export type LocatorIdentity = {
  uid: string;
  profile?: { email: string; displayName?: string };
};

export async function prepareLocatorAccess(identity: LocatorIdentity, env: Bindings) {
  // Compatibility with local profile bootstrap belongs to identity preparation,
  // not credential recovery. Preserve the parallel preparation for ordinary identities;
  // signed locator tickets carry only uid and never bootstrap a profile.
  const [binding] = await Promise.all([
    readBindingCredentials({ uid: identity.uid }, env),
    identity.profile
      ? ensureUserProfile(env.DB, { uid: identity.uid, ...identity.profile })
      : undefined,
  ]);
  return { uid: identity.uid, binding };
}
