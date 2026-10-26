import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { updateBindingCredentials } from "@/repositories/binding/repository";
import { publicBinding } from "@/services/official/auth/publicBinding";
import type { DecryptedBinding } from "@/services/official/auth/types";
import {
  generateEndfieldCredByCode,
  grantEndfieldOAuthCode,
  refreshEndfieldAuth,
} from "@/services/official/client/authClient";
import {
  createEndfieldDeviceId,
  createEndfieldDeviceProfile,
  SKLAND_DEVICE_PROFILE_USER_AGENT,
} from "@/services/official/client/deviceProfile";
import {
  isEndfieldCredentialErrorCode,
  isEndfieldCredentialExpiredErrorCode,
  isEndfieldDeviceErrorCode,
} from "@/services/official/client/positionParser";
import type { Bindings } from "@/types/app";

import {
  invalidateBindingCaches,
  getCredentialCache,
  readDecryptedBindingCache,
  writeDecryptedBindingCache,
} from "./credentialCache";
import { getBindingWithDeviceProfile } from "./deviceProfile";

// Create once per request or connection. Completed credentials use the separate short-lived cache.
export type CredentialRecoveryScope = Map<string, Promise<DecryptedBinding>>;
export type CredentialDependencies = {
  env: Bindings;
  recoveryScope: CredentialRecoveryScope;
};

export function createCredentialRecoveryScope(): CredentialRecoveryScope {
  return new Map();
}

export function getCredentialSecret(env: Bindings): string {
  const secret = env.ENDFIELD_CREDENTIAL_SECRET ?? env.BETTER_AUTH_SECRET;
  if (!secret || secret.trim().length < 16) {
    throw new ApiError(
      503,
      "ENDFIELD_CREDENTIAL_SECRET_MISSING",
      "Endfield credential encryption secret is not configured.",
    );
  }
  return secret;
}

async function loadBindingCredentials(
  env: Bindings,
  uid: string,
  options: { bypassCache?: boolean } = {},
): Promise<DecryptedBinding> {
  const cache = getCredentialCache(env);
  const revision = cache.revision;
  const cached = options.bypassCache ? null : readDecryptedBindingCache(env, uid);
  if (cached) {
    return cached;
  }

  const stored = await getBindingWithDeviceProfile(env.DB, uid);
  if (!stored) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  const { binding, deviceProfile } = stored;
  if (binding.status !== "enabled") {
    throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
  }

  const secret = getCredentialSecret(env);
  const [cred, token, accountToken] = await Promise.all([
    decryptSecret(binding.cred_enc, secret),
    decryptSecret(binding.token_enc, secret),
    binding.account_token_enc
      ? decryptSecret(binding.account_token_enc, secret).catch(() => undefined)
      : undefined,
  ]);

  const decrypted: DecryptedBinding = {
    binding,
    publicBinding: publicBinding(binding),
    cred,
    token,
    accountToken,
    wsBaseUrl: env.ENDFIELD_WS_BASE_URL,
    deviceProfile,
  };
  if (getCredentialCache(env) === cache && cache.revision === revision) {
    writeDecryptedBindingCache(env, uid, decrypted);
  }
  return decrypted;
}

export function isAutoRefreshableEndfieldError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  const details = error.details as { upstreamCode?: unknown; upstreamStatus?: unknown } | undefined;
  if (isEndfieldCredentialExpiredErrorCode(details?.upstreamCode)) {
    return false;
  }
  return (
    error.code === "ENDFIELD_CREDENTIAL_REJECTED" ||
    error.code === "ENDFIELD_DEVICE_REJECTED" ||
    details?.upstreamStatus === 401 ||
    details?.upstreamStatus === 403 ||
    isEndfieldCredentialErrorCode(details?.upstreamCode) ||
    isEndfieldDeviceErrorCode(details?.upstreamCode)
  );
}

async function updateStoredCredential(
  env: Bindings,
  uid: string,
  binding: DecryptedBinding,
  generated: { cred: string; token: string },
  deviceProfile = binding.deviceProfile,
): Promise<DecryptedBinding> {
  const secret = getCredentialSecret(env);
  const [encryptedCred, encryptedToken] = await Promise.all([
    encryptSecret(generated.cred, secret),
    encryptSecret(generated.token, secret),
  ]);
  const updated = await updateBindingCredentials(env.DB, {
    uid,
    binding: binding.binding,
    credEnc: encryptedCred,
    tokenEnc: encryptedToken,
    deviceProfile: deviceProfile !== binding.deviceProfile ? deviceProfile : undefined,
  });
  if (!updated) {
    return loadBindingCredentials(env, uid, { bypassCache: true });
  }
  invalidateBindingCaches(env, uid);

  const updatedBinding = {
    ...binding.binding,
    cred_enc: encryptedCred,
    token_enc: encryptedToken,
    status: "enabled" as const,
    updated_at: updated.updated_at,
  };
  const refreshed: DecryptedBinding = {
    ...binding,
    binding: updatedBinding,
    publicBinding: publicBinding(updatedBinding),
    cred: generated.cred,
    token: generated.token,
    deviceProfile,
  };
  writeDecryptedBindingCache(env, uid, refreshed);
  return refreshed;
}

async function performCredentialRefresh(
  env: Bindings,
  uid: string,
  binding: DecryptedBinding,
): Promise<DecryptedBinding> {
  const latest = await loadBindingCredentials(env, uid, { bypassCache: true });
  if (
    latest.binding.cred_enc !== binding.binding.cred_enc ||
    latest.binding.token_enc !== binding.binding.token_enc
  ) {
    return latest;
  }

  try {
    const refreshed = await refreshEndfieldAuth({
      provider: binding.binding.provider,
      cred: binding.cred,
      deviceProfile: binding.deviceProfile,
    });
    return updateStoredCredential(env, uid, binding, {
      cred: refreshed.cred ?? binding.cred,
      token: refreshed.token!,
    });
  } catch (refreshError) {
    let deviceProfile = binding.deviceProfile;
    const refreshDetails =
      refreshError instanceof ApiError
        ? (refreshError.details as { upstreamCode?: unknown } | undefined)
        : undefined;
    const deviceRejected =
      refreshError instanceof ApiError &&
      (refreshError.code === "ENDFIELD_DEVICE_REJECTED" ||
        isEndfieldDeviceErrorCode(refreshDetails?.upstreamCode));

    if (deviceRejected) {
      try {
        deviceProfile = createEndfieldDeviceProfile(
          await createEndfieldDeviceId(),
          SKLAND_DEVICE_PROFILE_USER_AGENT,
        );
        const refreshed = await refreshEndfieldAuth({
          provider: binding.binding.provider,
          cred: binding.cred,
          deviceProfile,
        });
        return updateStoredCredential(
          env,
          uid,
          binding,
          {
            cred: refreshed.cred ?? binding.cred,
            token: refreshed.token!,
          },
          deviceProfile,
        );
      } catch {
        // Fall through to account-token exchange, when available.
      }
    }

    if (!binding.accountToken) {
      throw refreshError;
    }

    try {
      const grant = await grantEndfieldOAuthCode(
        binding.binding.provider,
        binding.accountToken,
        deviceProfile,
      );
      const generated = await generateEndfieldCredByCode(
        binding.binding.provider,
        grant.code,
        deviceProfile,
      );
      return updateStoredCredential(env, uid, binding, generated, deviceProfile);
    } catch {
      throw refreshError;
    }
  }
}

/** Returns a local credential snapshot; the next official operation can still reject it. */
export function readBindingCredentials(
  input: { uid: string },
  env: Bindings,
): Promise<DecryptedBinding> {
  return loadBindingCredentials(env, input.uid);
}

/** Best-effort recovery after an observed rejection. It does not retry the business operation. */
export async function recoverBindingCredentials(
  input: { uid: string; rejectedCredentials: DecryptedBinding; rejection: unknown },
  { env, recoveryScope }: CredentialDependencies,
): Promise<DecryptedBinding> {
  if (!isAutoRefreshableEndfieldError(input.rejection)) {
    throw input.rejection;
  }
  const pending = recoveryScope.get(input.uid);
  if (pending) {
    return pending;
  }

  const refresh = performCredentialRefresh(env, input.uid, input.rejectedCredentials);
  recoveryScope.set(input.uid, refresh);
  try {
    return await refresh;
  } finally {
    if (recoveryScope.get(input.uid) === refresh) {
      recoveryScope.delete(input.uid);
    }
  }
}
