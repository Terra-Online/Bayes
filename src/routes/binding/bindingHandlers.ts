import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { generateEndfieldCredByCode, grantEndfieldOAuthCode } from "../../lib/endfieldClient/authClient";
import { agreePolicy } from "../../lib/endfieldClient/mapClient";
import { getEndfieldRoles } from "../../lib/endfieldClient/roleClient";
import { ApiError } from "../../lib/errors";
import { getCredentialSecret } from "./credentials";
import { requireUser } from "./helpers";
import { deleteLocatorCaches } from "./locatorCache";
import { deletePendingSession, readPendingSession, savePendingSession } from "./pendingSession";
import {
  deleteBinding,
  disableBinding,
  getBinding,
  getBindingDeviceProfile,
  getOrCreateRoleDeviceProfile,
  publicBinding,
  saveBinding
} from "./repository";
import { agreeSchema, bindRoleSchema, exchangeCodeSchema, exchangeTokenSchema } from "./schemas";
import type { AppContext } from "./types";

export async function handleBindingStatus(c: AppContext) {
  const user = requireUser(c);
  const binding = await getBinding(c.env.DB, user.uid);
  return c.json({ binding: publicBinding(binding) });
}

export async function handleExchangeToken(c: AppContext) {
  const user = requireUser(c);
  const payload = await c.req.json().catch(() => undefined);
  const parsed = exchangeTokenSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid exchange payload.", parsed.error.flatten());
  }

  try {
    const grant = await grantEndfieldOAuthCode(parsed.data.provider, parsed.data.token);
    const generated = await generateEndfieldCredByCode(parsed.data.provider, grant.code);
    const roles = await getEndfieldRoles(parsed.data.provider, generated.cred, generated.token);
    if (roles.length === 0) {
      throw new ApiError(404, "ENDFIELD_ROLE_NOT_FOUND", "No Endfield roles found on this account.");
    }

    const flowId = await savePendingSession(c, user.uid, {
      provider: parsed.data.provider,
      cred: generated.cred,
      token: generated.token,
      accountToken: parsed.data.token,
      roles,
      createdAt: Date.now()
    });

    return c.json({ flowId, roles });
  } catch (error) {
    if (error instanceof ApiError) {
      console.warn("[binding][endfield][exchange-token] failed", {
        requestId: c.get("requestId"),
        provider: parsed.data.provider,
        code: error.code,
        status: error.status,
        details: error.details,
      });
    }
    throw error;
  }
}

export async function handleExchangeCode(c: AppContext) {
  const user = requireUser(c);
  const parsed = exchangeCodeSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid exchange payload.", parsed.error.flatten());
  }

  const generated = await generateEndfieldCredByCode(parsed.data.provider, parsed.data.code);
  const roles = await getEndfieldRoles(parsed.data.provider, generated.cred, generated.token);
  if (roles.length === 0) {
    throw new ApiError(404, "ENDFIELD_ROLE_NOT_FOUND", "No Endfield roles found on this account.");
  }

  const flowId = await savePendingSession(c, user.uid, {
    provider: parsed.data.provider,
    cred: generated.cred,
    token: generated.token,
    roles,
    createdAt: Date.now()
  });

  return c.json({ flowId, roles });
}

export async function handleBindRole(c: AppContext) {
  const user = requireUser(c);
  const parsed = bindRoleSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid role payload.", parsed.error.flatten());
  }

  const pending = await readPendingSession(c, user.uid, parsed.data.flowId);
  const role = pending.roles.find(
    (item) => item.serverId === parsed.data.serverId && item.roleId === parsed.data.roleId
  );
  if (!role) {
    throw new ApiError(404, "ENDFIELD_ROLE_NOT_FOUND", "Selected role is not available in this binding flow.");
  }

  const secret = getCredentialSecret(c);
  await getOrCreateRoleDeviceProfile(c.env.DB, role.roleId);
  await saveBinding(c.env.DB, user.uid, pending.provider, role, {
    cred: await encryptSecret(pending.cred, secret),
    token: await encryptSecret(pending.token, secret),
    accountToken: pending.accountToken ? await encryptSecret(pending.accountToken, secret) : undefined
  });
  deleteLocatorCaches(user.uid);
  await deletePendingSession(c, user.uid, parsed.data.flowId);

  const binding = await getBinding(c.env.DB, user.uid);
  return c.json({ ok: true, binding: publicBinding(binding) });
}

export async function handleDisableBinding(c: AppContext) {
  const user = requireUser(c);
  await disableBinding(c.env.DB, user.uid);
  deleteLocatorCaches(user.uid);
  const binding = await getBinding(c.env.DB, user.uid);
  return c.json({ ok: true, binding: publicBinding(binding) });
}

export async function handleUnlinkBinding(c: AppContext) {
  const user = requireUser(c);
  await deleteBinding(c.env.DB, user.uid);
  deleteLocatorCaches(user.uid);
  return c.json({ ok: true, binding: publicBinding(null) });
}

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
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid agree-policy payload.", parsed.error.flatten());
  }

  const reqRole = parsed.data?.roleId;
  const reqServer = parsed.data?.serverId;
  if (
    (reqRole && reqRole !== binding.role_id)
    || (reqServer !== undefined && Number(reqServer) !== Number(binding.server_id))
  ) {
    throw new ApiError(409, "ENDFIELD_BINDING_MISMATCH", "Policy authorization target does not match the current Endfield binding.");
  }

  const secret = getCredentialSecret(c);
  await agreePolicy({
    provider: binding.provider,
    roleId: binding.role_id,
    serverId: Number(binding.server_id),
    cred: await decryptSecret(binding.cred_enc, secret),
    token: await decryptSecret(binding.token_enc, secret),
    deviceProfile: await getBindingDeviceProfile(c.env.DB, binding)
  });

  return c.json({ ok: true, binding: publicBinding(binding) });
}
