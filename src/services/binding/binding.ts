import { encryptSecret } from "@/lib/crypto";
import {
  generateEndfieldCredByCode,
  grantEndfieldOAuthCode,
} from "@/lib/endfieldClient/authClient";
import {
  createEndfieldDeviceId,
  createEndfieldDeviceProfile,
  SKLAND_DEVICE_PROFILE_USER_AGENT,
} from "@/lib/endfieldClient/deviceProfile";
import { getEndfieldRoles } from "@/lib/endfieldClient/roleClient";
import type {
  EndfieldDeviceProfile,
  EndfieldProvider,
  GenerateCredData,
} from "@/lib/endfieldClient/types";
import { ApiError } from "@/lib/errors";
import {
  deleteBinding,
  disableBinding as disableStoredBinding,
  getBinding,
  saveBinding,
  saveRoleDeviceProfile,
} from "@/repositories/binding/repository";

import {
  deletePendingSession,
  readPendingSession,
  savePendingSession,
  type PendingSessionDependencies,
} from "./pendingSession";

export type BindingDependencies = {
  db: D1Database;
  pending: PendingSessionDependencies;
  credentialSecret(): string;
  invalidateCaches(uid: string): void;
};
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
  dependencies: Pick<BindingDependencies, "pending">,
) {
  const deviceProfile = await exchangeDeviceProfile(input);
  const grant = await grantEndfieldOAuthCode(input.provider, input.token, deviceProfile);
  const generated = await generateEndfieldCredByCode(input.provider, grant.code, deviceProfile);
  return startBindingFlow(
    { ...input, accountToken: input.token },
    deviceProfile,
    generated,
    dependencies.pending,
  );
}

export async function exchangeBindingCode(
  input: ExchangeInput & { code: string },
  dependencies: Pick<BindingDependencies, "pending">,
) {
  const deviceProfile = await exchangeDeviceProfile(input);
  const generated = await generateEndfieldCredByCode(input.provider, input.code, deviceProfile);
  return startBindingFlow(input, deviceProfile, generated, dependencies.pending);
}

export async function bindRole(
  input: { uid: string; flowId: string; serverId: number; roleId: string },
  dependencies: BindingDependencies,
) {
  const pending = await readPendingSession(dependencies.pending, input.uid, input.flowId);
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

  const secret = dependencies.credentialSecret();
  // Preserve the existing write order and leave the pending flow available if persistence fails.
  await saveRoleDeviceProfile(
    dependencies.db,
    role.roleId,
    pending.deviceProfile ?? createEndfieldDeviceProfile(),
  );
  await saveBinding(dependencies.db, input.uid, pending.provider, role, {
    cred: await encryptSecret(pending.cred, secret),
    token: await encryptSecret(pending.token, secret),
    accountToken: pending.accountToken
      ? await encryptSecret(pending.accountToken, secret)
      : undefined,
  });
  dependencies.invalidateCaches(input.uid);
  await deletePendingSession(dependencies.pending, input.uid, input.flowId);

  return getBinding(dependencies.db, input.uid);
}

export async function disableBinding(
  input: { uid: string },
  dependencies: Pick<BindingDependencies, "db" | "invalidateCaches">,
) {
  await disableStoredBinding(dependencies.db, input.uid);
  dependencies.invalidateCaches(input.uid);
  return getBinding(dependencies.db, input.uid);
}

export async function unlinkBinding(
  input: { uid: string },
  dependencies: Pick<BindingDependencies, "db" | "invalidateCaches">,
): Promise<void> {
  await deleteBinding(dependencies.db, input.uid);
  dependencies.invalidateCaches(input.uid);
}
