import { decryptSecret } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { getBinding } from "@/repositories/binding/repository";
import type { EndfieldBindingRow } from "@/repositories/binding/types";
import { getCredentialSecret } from "@/services/official/auth/credentials";
import { getBindingDeviceProfile } from "@/services/official/auth/deviceProfile";
import { publicBinding } from "@/services/official/auth/publicBinding";
import { agreePolicy } from "@/services/official/client/mapClient";
import type { Bindings } from "@/types/app";

export async function preparePositionPolicy(input: { uid: string }, env: Bindings) {
  const binding = await getBinding(env.DB, input.uid);
  if (!binding) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  if (binding.status !== "enabled") {
    throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
  }
  return binding;
}

export async function authorizePositionPolicy(
  input: {
    binding: EndfieldBindingRow;
    target?: { roleId?: string; serverId?: number | string };
  },
  env: Bindings,
) {
  const { binding, target } = input;
  if (
    (target?.roleId && target.roleId !== binding.role_id) ||
    (target?.serverId !== undefined && Number(target.serverId) !== Number(binding.server_id))
  ) {
    throw new ApiError(
      409,
      "ENDFIELD_BINDING_MISMATCH",
      "Policy authorization target does not match the current Endfield binding.",
    );
  }
  const secret = getCredentialSecret(env);
  // Authorization is an upstream write. Preserve the existing single attempt.
  await agreePolicy({
    provider: binding.provider,
    roleId: binding.role_id,
    serverId: Number(binding.server_id),
    cred: await decryptSecret(binding.cred_enc, secret),
    token: await decryptSecret(binding.token_enc, secret),
    deviceProfile: await getBindingDeviceProfile(env.DB, binding),
  });
  return publicBinding(binding);
}
