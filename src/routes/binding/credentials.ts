import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { generateEndfieldCredByCode, grantEndfieldOAuthCode, refreshEndfieldAuth } from "../../lib/endfieldClient/authClient";
import {
  createEndfieldDeviceId,
  createEndfieldDeviceProfile,
  SKLAND_DEVICE_PROFILE_USER_AGENT
} from "../../lib/endfieldClient/deviceProfile";
import {
  isEndfieldCredentialErrorCode,
  isEndfieldDeviceErrorCode
} from "../../lib/endfieldClient/positionParser";
import { ApiError } from "../../lib/errors";
import { deleteLocatorCaches, readDecryptedBindingCache, writeDecryptedBindingCache } from "./locatorCache";
import { getBindingWithDeviceProfile, publicBinding, saveRoleDeviceProfile } from "./repository";
import type { AppContext, DecryptedBinding } from "./types";

const credentialRefreshInFlight = new Map<string, Promise<DecryptedBinding | null>>();

export function getCredentialSecret(c: AppContext): string {
  const secret = c.env.ENDFIELD_CREDENTIAL_SECRET ?? c.env.BETTER_AUTH_SECRET;
  if (!secret || secret.trim().length < 16) {
    throw new ApiError(503, "ENDFIELD_CREDENTIAL_SECRET_MISSING", "Endfield credential encryption secret is not configured.");
  }
  return secret;
}

export async function getDecryptedBinding(
  c: AppContext,
  uid: string,
  options: { bypassCache?: boolean } = {}
): Promise<DecryptedBinding> {
  const cached = options.bypassCache ? null : readDecryptedBindingCache(uid);
  if (cached) {
    return cached;
  }

  const stored = await getBindingWithDeviceProfile(c.env.DB, uid);
  if (!stored) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  const { binding, deviceProfile } = stored;
  if (binding.status !== "enabled") {
    throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
  }

  const secret = getCredentialSecret(c);
  const [cred, token, accountToken] = await Promise.all([
    decryptSecret(binding.cred_enc, secret),
    decryptSecret(binding.token_enc, secret),
    binding.account_token_enc
      ? decryptSecret(binding.account_token_enc, secret).catch(() => undefined)
      : undefined
  ]);

  const decrypted: DecryptedBinding = {
    binding,
    publicBinding: publicBinding(binding),
    cred,
    token,
    accountToken,
    wsBaseUrl: c.env.ENDFIELD_WS_BASE_URL,
    deviceProfile
  };
  writeDecryptedBindingCache(uid, decrypted);
  return decrypted;
}

export function isAutoRefreshableEndfieldError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const details = error.details as { upstreamCode?: unknown; upstreamStatus?: unknown } | undefined;
  return error.code === "ENDFIELD_CREDENTIAL_REJECTED"
    || error.code === "ENDFIELD_DEVICE_REJECTED"
    || details?.upstreamStatus === 401
    || details?.upstreamStatus === 403
    || isEndfieldCredentialErrorCode(details?.upstreamCode)
    || isEndfieldDeviceErrorCode(details?.upstreamCode);
}

async function updateStoredCredential(
  c: AppContext,
  uid: string,
  binding: DecryptedBinding,
  generated: { cred: string; token: string },
  deviceProfile = binding.deviceProfile
): Promise<DecryptedBinding> {
  const secret = getCredentialSecret(c);
  const [encryptedCred, encryptedToken] = await Promise.all([
    encryptSecret(generated.cred, secret),
    encryptSecret(generated.token, secret)
  ]);
  const updated = await c.env.DB
    .prepare(
      `UPDATE endfield_bindings
      SET cred_enc = ?2, token_enc = ?3, status = 'enabled', updated_at = CURRENT_TIMESTAMP
      WHERE uid = ?1
      RETURNING updated_at`
    )
    .bind(
      uid,
      encryptedCred,
      encryptedToken
    )
    .first<{ updated_at: string }>();
  if (!updated) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  deleteLocatorCaches(uid);

  const updatedBinding = {
    ...binding.binding,
    cred_enc: encryptedCred,
    token_enc: encryptedToken,
    status: "enabled" as const,
    updated_at: updated.updated_at
  };
  const refreshed: DecryptedBinding = {
    ...binding,
    binding: updatedBinding,
    publicBinding: publicBinding(updatedBinding),
    cred: generated.cred,
    token: generated.token,
    deviceProfile
  };
  writeDecryptedBindingCache(uid, refreshed);
  return refreshed;
}

async function performCredentialRefresh(
  c: AppContext,
  uid: string,
  binding: DecryptedBinding
): Promise<DecryptedBinding | null> {
  const latest = await getDecryptedBinding(c, uid, { bypassCache: true });
  if (
    latest.binding.cred_enc !== binding.binding.cred_enc
    || latest.binding.token_enc !== binding.binding.token_enc
  ) {
    return latest;
  }

  try {
    const refreshed = await refreshEndfieldAuth({
      provider: binding.binding.provider,
      cred: binding.cred,
      deviceProfile: binding.deviceProfile
    });
    return updateStoredCredential(c, uid, binding, {
      cred: refreshed.cred ?? binding.cred,
      token: refreshed.token!
    });
  } catch (refreshError) {
    let deviceProfile = binding.deviceProfile;
    const refreshDetails = refreshError instanceof ApiError
      ? refreshError.details as { upstreamCode?: unknown } | undefined
      : undefined;
    const deviceRejected = refreshError instanceof ApiError
      && (refreshError.code === "ENDFIELD_DEVICE_REJECTED" || isEndfieldDeviceErrorCode(refreshDetails?.upstreamCode));

    if (deviceRejected) {
      try {
        deviceProfile = createEndfieldDeviceProfile(
          await createEndfieldDeviceId(),
          SKLAND_DEVICE_PROFILE_USER_AGENT
        );
        await saveRoleDeviceProfile(c.env.DB, binding.binding.role_id, deviceProfile);
        const refreshed = await refreshEndfieldAuth({
          provider: binding.binding.provider,
          cred: binding.cred,
          deviceProfile
        });
        return updateStoredCredential(c, uid, binding, {
          cred: refreshed.cred ?? binding.cred,
          token: refreshed.token!
        }, deviceProfile);
      } catch {
        // Fall through to account-token exchange, when available.
      }
    }

    if (!binding.accountToken) throw refreshError;

    try {
      const grant = await grantEndfieldOAuthCode(
        binding.binding.provider,
        binding.accountToken,
        deviceProfile
      );
      const generated = await generateEndfieldCredByCode(
        binding.binding.provider,
        grant.code,
        deviceProfile
      );
      return updateStoredCredential(c, uid, binding, generated, deviceProfile);
    } catch {
      throw refreshError;
    }
  }
}

export async function refreshBindingCredentials(
  c: AppContext,
  uid: string,
  binding: DecryptedBinding
): Promise<DecryptedBinding | null> {
  const pending = credentialRefreshInFlight.get(uid);
  if (pending) return pending;

  const refresh = performCredentialRefresh(c, uid, binding);
  credentialRefreshInFlight.set(uid, refresh);
  try {
    return await refresh;
  } finally {
    if (credentialRefreshInFlight.get(uid) === refresh) {
      credentialRefreshInFlight.delete(uid);
    }
  }
}

export async function withAutoRefreshedBinding<T>(
  c: AppContext,
  uid: string,
  operation: (binding: DecryptedBinding) => Promise<T>,
  initialBinding?: DecryptedBinding
): Promise<T> {
  const binding = initialBinding ?? await getDecryptedBinding(c, uid);
  try {
    return await operation(binding);
  } catch (error) {
    if (!isAutoRefreshableEndfieldError(error)) {
      throw error;
    }
    const refreshed = await refreshBindingCredentials(c, uid, binding);
    if (!refreshed) {
      throw error;
    }
    return operation(refreshed);
  }
}
