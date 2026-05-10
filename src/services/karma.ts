import type { Redis } from "@upstash/redis";
import {
  getApprovedCommentDailyBackoffTtlSeconds,
  calculateKarmaEvaluationScore,
  getApprovedImageDailyBackoffTtlSeconds,
  getKarmaEvaluationBatchSize,
  getKarmaEvaluationIntervalSeconds,
  getModerationPointsDelta,
  pointsToKarma
} from "../lib/karma";

const KARMA_EVALUATION_LOCK_KEY = "karma:evaluation:last-run";
const KARMA_DIRTY_SET_KEY = "karma:evaluation:dirty-users";
const KARMA_SWEEP_CURSOR_KEY = "karma:evaluation:sweep-cursor";
const KARMA_EVALUATION_QUERY_CHUNK_SIZE = 500;
const DAILY_APPROVED_SUBMISSION_KEY_PREFIX = "karma:approved-submissions:";

type KarmaEvaluationResult = {
  evaluated: boolean;
  selected: number;
  dirtySelected: number;
  sweepSelected: number;
  updated: number;
};

type KarmaEvaluationRow = {
  uid: string;
  karma: number | string;
  points: number | string;
  created_at: string;
  last_active: string;
  approved_images: number | string | null;
  rejected_images: number | string | null;
};

export async function markKarmaDirty(redis: Redis, uid: string): Promise<void> {
  const normalizedUid = uid.trim();
  if (!normalizedUid) {
    return;
  }

  await redis.sadd(KARMA_DIRTY_SET_KEY, normalizedUid);
}

export async function getModerationPointsDeltaWithDailyBackoff(
  redis: Redis | undefined,
  payload: {
    userId: string;
    kind: "image" | "comment";
    status: "active" | "stale";
    role?: string | null;
    surgeModeEnabled?: boolean;
    surgeBackoffMultiplier?: number;
  }
): Promise<number> {
  const minimumActivePoints = payload.role === "p" || payload.role === "a" ? 1 : 0;
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
  kind: "image" | "comment"
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

export async function evaluateKarmaIfDue(
  db: D1Database,
  redis: Redis
): Promise<KarmaEvaluationResult> {
  const intervalSeconds = getKarmaEvaluationIntervalSeconds();
  const lockPlaced = await redis.set(KARMA_EVALUATION_LOCK_KEY, String(Date.now()), {
    nx: true,
    ex: intervalSeconds
  });

  if (!lockPlaced) {
    return {
      evaluated: false,
      selected: 0,
      dirtySelected: 0,
      sweepSelected: 0,
      updated: 0
    };
  }

  return evaluateKarmaBatch(db, redis);
}

export async function evaluateKarmaBatch(
  db: D1Database,
  redis: Redis
): Promise<KarmaEvaluationResult> {
  const limit = getKarmaEvaluationBatchSize();
  const sweepLimit = Math.max(1, Math.floor(limit * 0.25));
  const dirtyLimit = Math.max(0, limit - sweepLimit);
  const dirtyUids = await listDirtyKarmaUids(redis, dirtyLimit);
  const sweepUids = await listKarmaSweepUids(db, redis, limit - dirtyUids.length);
  const selectedUids = [...new Set([...dirtyUids, ...sweepUids])].slice(0, limit);
  const updated = await evaluateKarmaUsers(db, selectedUids);

  for (const uid of dirtyUids) {
    await redis.srem(KARMA_DIRTY_SET_KEY, uid);
  }

  return {
    evaluated: true,
    selected: selectedUids.length,
    dirtySelected: dirtyUids.length,
    sweepSelected: sweepUids.length,
    updated
  };
}

async function evaluateKarmaUsers(db: D1Database, uids: string[]): Promise<number> {
  if (uids.length === 0) {
    return 0;
  }

  let updated = 0;
  for (let index = 0; index < uids.length; index += KARMA_EVALUATION_QUERY_CHUNK_SIZE) {
    updated += await evaluateKarmaUserChunk(db, uids.slice(index, index + KARMA_EVALUATION_QUERY_CHUNK_SIZE));
  }
  return updated;
}

async function evaluateKarmaUserChunk(db: D1Database, uids: string[]): Promise<number> {
  const placeholders = uids.map((_, index) => `?${index + 1}`).join(", ");
  const rows = await db
    .prepare(
      `WITH image_stats AS (
         SELECT
           user_id,
           SUM(CASE WHEN kind = 'image' AND status IN ('active', 'flagged', 'remove_request') THEN 1 ELSE 0 END) AS approved_images,
           SUM(CASE WHEN kind = 'image' AND status = 'stale' THEN 1 ELSE 0 END) AS rejected_images
         FROM ugc_submissions
         WHERE kind = 'image'
           AND user_id IN (${placeholders})
         GROUP BY user_id
       )
       SELECT
         u.uid,
         u.karma,
         u.points,
         u.created_at,
         u.last_active,
         COALESCE(s.approved_images, 0) AS approved_images,
         COALESCE(s.rejected_images, 0) AS rejected_images
       FROM users u
       LEFT JOIN image_stats s ON s.user_id = u.uid
       WHERE u.role != 'r'
         AND u.uid IN (${placeholders})`
    )
    .bind(...uids)
    .all<KarmaEvaluationRow>();

  let updated = 0;
  for (const row of rows.results ?? []) {
    const currentKarma = toFiniteNumber(row.karma);
    const score = calculateKarmaEvaluationScore({
      points: toFiniteNumber(row.points),
      createdAt: row.created_at,
      lastActive: row.last_active,
      approvedImages: toFiniteNumber(row.approved_images),
      rejectedImages: toFiniteNumber(row.rejected_images)
    });
    const nextKarma = currentKarma >= 5 ? 5 : pointsToKarma(score);
    if (nextKarma === currentKarma) {
      continue;
    }

    const result = await db
      .prepare("UPDATE users SET karma = ?2 WHERE uid = ?1")
      .bind(row.uid, nextKarma)
      .run();
    updated += result.meta.changes ?? 0;
  }

  return updated;
}

function toFiniteNumber(value: number | string | null): number {
  const normalized = Number(value ?? 0);
  return Number.isFinite(normalized) ? normalized : 0;
}

async function listDirtyKarmaUids(redis: Redis, limit: number): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }

  const dirtyUsers = await redis.smembers<string[]>(KARMA_DIRTY_SET_KEY);
  if (!dirtyUsers || dirtyUsers.length === 0) {
    return [];
  }

  return dirtyUsers
    .map((uid) => String(uid).trim())
    .filter(Boolean)
    .slice(0, limit);
}

async function listKarmaSweepUids(db: D1Database, redis: Redis, limit: number): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }

  const cursor = String((await redis.get<string>(KARMA_SWEEP_CURSOR_KEY)) ?? "");
  const firstBatch = await selectSweepUidsAfter(db, cursor, limit);
  let uids = firstBatch;

  if (cursor && firstBatch.length < limit) {
    const wrappedBatch = await selectSweepUidsAfter(db, "", limit - firstBatch.length);
    uids = [...firstBatch, ...wrappedBatch];
  }

  const uniqueUids = [...new Set(uids)].slice(0, limit);
  const nextCursor = uniqueUids.at(-1);
  if (nextCursor) {
    await redis.set(KARMA_SWEEP_CURSOR_KEY, nextCursor);
  } else {
    await redis.del(KARMA_SWEEP_CURSOR_KEY);
  }

  return uniqueUids;
}

async function selectSweepUidsAfter(db: D1Database, cursor: string, limit: number): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT uid
       FROM users
       WHERE role != 'r'
         AND uid > ?1
       ORDER BY uid ASC
       LIMIT ?2`
    )
    .bind(cursor, limit)
    .all<{ uid: string }>();

  return (result.results ?? [])
    .map((row) => row.uid)
    .filter(Boolean);
}
