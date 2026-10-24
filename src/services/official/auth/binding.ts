import { encryptSecret } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { createRedisClient } from "@/lib/redis";
import {
  deleteBinding,
  disableBinding as disableStoredBinding,
  getBinding,
  saveBinding,
  saveRoleDeviceProfile,
} from "@/repositories/binding/repository";
import {
  generateEndfieldCredByCode,
  grantEndfieldOAuthCode,
} from "@/services/official/client/authClient";
import {
  createEndfieldDeviceId,
  createEndfieldDeviceProfile,
  SKLAND_DEVICE_PROFILE_USER_AGENT,
} from "@/services/official/client/deviceProfile";
import { getEndfieldRoles } from "@/services/official/client/roleClient";
import type { GenerateCredData } from "@/services/official/client/types";
import type { EndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";
import type { EndfieldProvider } from "@/services/official/contract/provider";
import type { Bindings } from "@/types/app";

import { invalidateBindingCaches } from "./credentialCache";
import { getCredentialSecret } from "./credentials";
import {
  getPendingKey,
  deletePendingSession,
  readPendingSession,
  savePendingSession,
  type PendingSessionDependencies,
} from "./pendingSession";

function pendingDependencies(env: Bindings): PendingSessionDependencies {
  return {
    redis: () => createRedisClient(env),
    key: (uid, flowId) => getPendingKey(env, uid, flowId),
  };
}
type ExchangeInput = {
  uid: string;
  provider: EndfieldProvider;
  deviceId?: string;
  userAgent?: string;
};

async function exchangeDeviceProfile(input: ExchangeInput): Promise<EndfieldDeviceProfile> {
  let deviceId = input.deviceId;
  if (!deviceId) {
    try {
      deviceId = await createEndfieldDeviceId();
    } catch (error) {
      throw new ApiError(
        502,
        "ENDFIELD_DEVICE_ID_GENERATION_FAILED",
        "Failed to obtain a Skland device id.",
        {
          cause: error instanceof Error ? error.message : "unknown",
        },
      );
    }
  }
  return createEndfieldDeviceProfile(
    deviceId,
    input.deviceId ? input.userAgent : SKLAND_DEVICE_PROFILE_USER_AGENT,
  );
}

async function startBindingFlow(
  input: ExchangeInput & { accountToken?: string },
  deviceProfile: EndfieldDeviceProfile,
  generated: GenerateCredData,
  pending: PendingSessionDependencies,
) {
  const roles = await getEndfieldRoles(
    input.provider,
    generated.cred,
    generated.token,
    deviceProfile,
  );
  if (roles.length === 0) {
    throw new ApiError(404, "ENDFIELD_ROLE_NOT_FOUND", "No Endfield roles found on this account.");
  }
  const flowId = await savePendingSession(pending, input.uid, {
    provider: input.provider,
    deviceProfile,
    cred: generated.cred,
    token: generated.token,
    ...(input.accountToken !== undefined ? { accountToken: input.accountToken } : {}),
    roles,
    createdAt: Date.now(),
  });
  return { flowId, roles };
}

export async function exchangeBindingToken(
  input: ExchangeInput & { token: string },
  env: Bindings,
) {
  const deviceProfile = await exchangeDeviceProfile(input);
  const grant = await grantEndfieldOAuthCode(input.provider, input.token, deviceProfile);
  const generated = await generateEndfieldCredByCode(input.provider, grant.code, deviceProfile);
  return startBindingFlow(
    { ...input, accountToken: input.token },
    deviceProfile,
    generated,
    pendingDependencies(env),
  );
}

export async function exchangeBindingCode(input: ExchangeInput & { code: string }, env: Bindings) {
  const deviceProfile = await exchangeDeviceProfile(input);
  const generated = await generateEndfieldCredByCode(input.provider, input.code, deviceProfile);
  return startBindingFlow(input, deviceProfile, generated, pendingDependencies(env));
}

export async function bindRole(
  input: { uid: string; flowId: string; serverId: number; roleId: string },
  env: Bindings,
) {
  const pending = await readPendingSession(pendingDependencies(env), input.uid, input.flowId);
  const role = pending.roles.find(
    (item) => item.serverId === input.serverId && item.roleId === input.roleId,
  );
  if (!role) {
    throw new ApiError(
      404,
      "ENDFIELD_ROLE_NOT_FOUND",
      "Selected role is not available in this binding flow.",
    );
  }

  const secret = getCredentialSecret(env);
  // Preserve the existing write order and leave the pending flow available if persistence fails.
  await saveRoleDeviceProfile(
    env.DB,
    role.roleId,
    pending.deviceProfile ?? createEndfieldDeviceProfile(),
  );
  await saveBinding(
    env.DB,
    input.uid,
    pending.provider,
    {
      serverId: role.serverId,
      roleId: role.roleId,
      nickname: role.nickname,
      serverName: role.serverName,
    },
    {
      cred: await encryptSecret(pending.cred, secret),
      token: await encryptSecret(pending.token, secret),
      accountToken: pending.accountToken
        ? await encryptSecret(pending.accountToken, secret)
        : undefined,
    },
  );
  invalidateBindingCaches(env, input.uid);
  await deletePendingSession(pendingDependencies(env), input.uid, input.flowId);

  return getBinding(env.DB, input.uid);
}

export async function disableBinding(input: { uid: string }, env: Bindings) {
  await disableStoredBinding(env.DB, input.uid);
  invalidateBindingCaches(env, input.uid);
  return getBinding(env.DB, input.uid);
}

export async function unlinkBinding(input: { uid: string }, env: Bindings): Promise<void> {
  await deleteBinding(env.DB, input.uid);
  invalidateBindingCaches(env, input.uid);
}
