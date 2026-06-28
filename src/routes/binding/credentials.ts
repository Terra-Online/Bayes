import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { generateEndfieldCredByCode, grantEndfieldOAuthCode, refreshEndfieldAuth } from "../../lib/endfieldClient/authClient";
import { ApiError } from "../../lib/errors";
import { deleteLocatorCaches, readDecryptedBindingCache, writeDecryptedBindingCache } from "./locatorCache";
import { getBinding, getBindingDeviceProfile, publicBinding } from "./repository";
import type { AppContext, DecryptedBinding } from "./types";

export function getCredentialSecret(c: AppContext): string {
  const secret = c.env.ENDFIELD_CREDENTIAL_SECRET ?? c.env.BETTER_AUTH_SECRET;
  if (!secret || secret.trim().length < 16) {
    throw new ApiError(503, "ENDFIELD_CREDENTIAL_SECRET_MISSING", "Endfield credential encryption secret is not configured.");
  }
  return secret;
}

export async function getDecryptedBinding(c: AppContext, uid: string): Promise<DecryptedBinding> {
  const cached = readDecryptedBindingCache(uid);
  if (cached) {
    return cached;
  }

  const binding = await getBinding(c.env.DB, uid);
  if (!binding) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  if (binding.status !== "enabled") {
    throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
  }
  const deviceProfile = await getBindingDeviceProfile(c.env.DB, binding);

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
  const upstreamCode = Number(details?.upstreamCode);
  return error.code === "ENDFIELD_CREDENTIAL_REJECTED"
    || error.code === "ENDFIELD_POSITION_SOCKET_UNAVAILABLE"
    || details?.upstreamStatus === 401
    || details?.upstreamStatus === 403
    || upstreamCode === 10000;
}

async function updateStoredCredential(
  c: AppContext,
  uid: string,
  generated: { cred: string; token: string }
): Promise<void> {
  const secret = getCredentialSecret(c);
  await c.env.DB
    .prepare(
      `UPDATE endfield_bindings
      SET cred_enc = ?2, token_enc = ?3, status = 'enabled', updated_at = CURRENT_TIMESTAMP
      WHERE uid = ?1`
    )
    .bind(
      uid,
      await encryptSecret(generated.cred, secret),
      await encryptSecret(generated.token, secret)
    )
    .run();
  deleteLocatorCaches(uid);
}

export async function refreshBindingCredentials(
  c: AppContext,
  uid: string,
  binding: DecryptedBinding
): Promise<DecryptedBinding | null> {
  if (binding.accountToken) {
    try {
      const grant = await grantEndfieldOAuthCode(
        binding.binding.provider,
        binding.accountToken,
        binding.deviceProfile
      );
      const generated = await generateEndfieldCredByCode(
        binding.binding.provider,
        grant.code,
        binding.deviceProfile
      );
      await updateStoredCredential(c, uid, generated);
      return getDecryptedBinding(c, uid);
    } catch {
      // Fall through to the lightweight refresh endpoint before forcing a rebind.
    }
  }

  const refreshed = await refreshEndfieldAuth({
    provider: binding.binding.provider,
    cred: binding.cred,
    deviceProfile: binding.deviceProfile
  });
  await updateStoredCredential(c, uid, {
    cred: refreshed.cred ?? binding.cred,
    token: refreshed.token!
  });
  return getDecryptedBinding(c, uid);
}

export async function withAutoRefreshedBinding<T>(
  c: AppContext,
  uid: string,
  operation: (binding: DecryptedBinding) => Promise<T>
): Promise<T> {
  const binding = await getDecryptedBinding(c, uid);
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
