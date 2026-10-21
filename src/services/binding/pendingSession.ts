import { createToken } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { hmacServiceIdentifier } from "@/lib/serviceIdentity";
import {
  savePendingRecord,
  readPendingRecord,
  deletePendingRecord,
  type PendingSessionRedis,
} from "@/repositories/binding/pendingSession";
import { pendingSessionSchema } from "@/services/binding/contract/schemas";
import type { PendingEndfieldSession } from "@/services/binding/types";

export type PendingSessionDependencies = {
  // Preserve lazy client creation so storage setup happens only when the flow reaches Redis.
  redis(): PendingSessionRedis;
  key(uid: string, flowId: string): Promise<string>;
};

const PENDING_TTL_SECONDS = 10 * 60;

export async function getPendingKey(
  env: Parameters<typeof hmacServiceIdentifier>[0],
  uid: string,
  flowId: string,
): Promise<string> {
  const keyId = await hmacServiceIdentifier(env, "binding:endfield:pending", `${uid}:${flowId}`);
  return `binding:endfield:pending:${keyId}`;
}

export async function savePendingSession(
  dependencies: PendingSessionDependencies,
  uid: string,
  session: PendingEndfieldSession,
): Promise<string> {
  const redis = dependencies.redis();
  const flowId = createToken(24);
  await savePendingRecord(redis, await dependencies.key(uid, flowId), session, PENDING_TTL_SECONDS);
  return flowId;
}

export async function readPendingSession(
  dependencies: PendingSessionDependencies,
  uid: string,
  flowId: string,
): Promise<PendingEndfieldSession> {
  const redis = dependencies.redis();
  const raw = await readPendingRecord(redis, await dependencies.key(uid, flowId));
  if (!raw) {
    throw new ApiError(
      410,
      "ENDFIELD_BINDING_FLOW_EXPIRED",
      "Binding flow expired. Please exchange the token again.",
    );
  }

  try {
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    return pendingSessionSchema.parse(payload);
  } catch {
    throw new ApiError(
      410,
      "ENDFIELD_BINDING_FLOW_INVALID",
      "Binding flow is invalid. Please exchange the token again.",
    );
  }
}

export async function deletePendingSession(
  dependencies: PendingSessionDependencies,
  uid: string,
  flowId: string,
): Promise<void> {
  const redis = dependencies.redis();
  await deletePendingRecord(redis, await dependencies.key(uid, flowId));
}
