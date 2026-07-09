import { createToken } from "../../lib/crypto";
import { ApiError } from "../../lib/errors";
import { createRedisClient } from "../../lib/redis";
import { pendingSessionSchema } from "./schemas";
import type { AppContext, PendingEndfieldSession } from "./types";

const PENDING_TTL_SECONDS = 10 * 60;

export function getPendingKey(uid: string, flowId: string): string {
  return `binding:endfield:pending:${uid}:${flowId}`;
}

export async function savePendingSession(
  c: AppContext,
  uid: string,
  session: PendingEndfieldSession
): Promise<string> {
  const redis = createRedisClient(c.env);
  const flowId = createToken(24);
  await redis.set(getPendingKey(uid, flowId), JSON.stringify(session), { ex: PENDING_TTL_SECONDS });
  return flowId;
}

export async function readPendingSession(
  c: AppContext,
  uid: string,
  flowId: string
): Promise<PendingEndfieldSession> {
  const redis = createRedisClient(c.env);
  const raw = await redis.get<unknown>(getPendingKey(uid, flowId));
  if (!raw) {
    throw new ApiError(410, "ENDFIELD_BINDING_FLOW_EXPIRED", "Binding flow expired. Please exchange the token again.");
  }

  try {
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    return pendingSessionSchema.parse(payload);
  } catch {
    throw new ApiError(410, "ENDFIELD_BINDING_FLOW_INVALID", "Binding flow is invalid. Please exchange the token again.");
  }
}

export async function deletePendingSession(c: AppContext, uid: string, flowId: string): Promise<void> {
  const redis = createRedisClient(c.env);
  await redis.del(getPendingKey(uid, flowId));
}
