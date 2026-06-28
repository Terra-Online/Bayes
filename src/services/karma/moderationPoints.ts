import type { Redis } from "@upstash/redis";
import {
  getApprovedCommentDailyBackoffTtlSeconds,
  getApprovedImageDailyBackoffTtlSeconds,
  getModerationPointsDelta,
  type KarmaModerationKind,
  type KarmaModerationStatus
} from "../../lib/karma/rules";

const DAILY_APPROVED_SUBMISSION_KEY_PREFIX = "karma:approved-submissions:";

export async function getModerationPointsDeltaWithDailyBackoff(
  redis: Redis | undefined,
  payload: {
    userId: string;
    kind: KarmaModerationKind;
    status: KarmaModerationStatus;
    role?: string | null;
    surgeModeEnabled?: boolean;
    surgeBackoffMultiplier?: number;
  }
): Promise<number> {
  const minimumActivePoints = payload.role === "p" || payload.role === "a" || payload.role === "r" ? 1 : 0;
  const backoffMultiplier = payload.surgeModeEnabled ? payload.surgeBackoffMultiplier ?? 3 : 1;
  if (payload.status !== "active" || !redis) {
    return getModerationPointsDelta(payload.kind, payload.status, 1, minimumActivePoints, backoffMultiplier);
  }

  const approvedCount = await incrementDailyApprovedSubmissionCount(redis, payload.userId, payload.kind);
  return getModerationPointsDelta(payload.kind, payload.status, approvedCount, minimumActivePoints, backoffMultiplier);
}

async function incrementDailyApprovedSubmissionCount(
  redis: Redis,
  uid: string,
  kind: KarmaModerationKind
): Promise<number> {
  const key = `${DAILY_APPROVED_SUBMISSION_KEY_PREFIX}${kind}:${new Date().toISOString().slice(0, 10)}:${uid}`;
  const count = await redis.incrby(key, 1);
  await redis.expire(
    key,
    kind === "comment"
      ? getApprovedCommentDailyBackoffTtlSeconds()
      : getApprovedImageDailyBackoffTtlSeconds()
  );

  const normalized = Number(count);
  return Number.isFinite(normalized) ? Math.max(1, Math.floor(normalized)) : 1;
}
