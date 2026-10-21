import { decryptSecret } from "@/lib/crypto";
import { agreePolicy } from "@/lib/endfieldClient/mapClient";
import { ApiError } from "@/lib/errors";
import {
  getBinding,
  getBindingDeviceProfile,
  publicBinding,
} from "@/repositories/binding/repository";
import { getCredentialSecret } from "@/routes/binding/credentials";
import { requireUser } from "@/routes/binding/helpers";
import type { AppContext } from "@/routes/binding/types";
import { agreeSchema } from "@/routes/schema/locator";

export async function handleAgree(c: AppContext) {
  const user = requireUser(c);
  const binding = await getBinding(c.env.DB, user.uid);
  if (!binding) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  if (binding.status !== "enabled") {
    throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
  }

  const payload = await c.req.json().catch(() => undefined);
  const parsed = agreeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Invalid agree-policy payload.",
      parsed.error.flatten(),
    );
  }

  const reqRole = parsed.data?.roleId;
  const reqServer = parsed.data?.serverId;
  if (
    (reqRole && reqRole !== binding.role_id) ||
    (reqServer !== undefined && Number(reqServer) !== Number(binding.server_id))
  ) {
    throw new ApiError(
      409,
      "ENDFIELD_BINDING_MISMATCH",
      "Policy authorization target does not match the current Endfield binding.",
    );
  }

  const secret = getCredentialSecret(c);
  await agreePolicy({
    provider: binding.provider,
    roleId: binding.role_id,
    serverId: Number(binding.server_id),
    cred: await decryptSecret(binding.cred_enc, secret),
    token: await decryptSecret(binding.token_enc, secret),
    deviceProfile: await getBindingDeviceProfile(c.env.DB, binding),
  });

  return c.json({ ok: true, binding: publicBinding(binding) });
}
