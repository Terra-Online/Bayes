import type { Redis } from "@upstash/redis";
import { AI_STALE_MODERATION_NOTE_PREFIX, RECALL_MODERATION_NOTE_PREFIX } from "../../lib/moderation";
import {
  calculateKarmaEvaluationScore,
  getKarmaEvaluationBatchSize,
  getKarmaEvaluationIntervalSeconds,
  pointsToKarma
} from "../../lib/karma/rules";

const KARMA_EVALUATION_LEASE_KEY = "karma:evaluation:v2:lease";
const KARMA_EVALUATION_CYCLE_KEY = "karma:evaluation:v2:cycle";
const KARMA_EVALUATION_LEASE_SECONDS = 180;
const KARMA_EVALUATION_BUDGET_MS = 45_000;
const KARMA_EVALUATION_QUERY_CHUNK_SIZE = 90;

const SAVE_CYCLE_SCRIPT = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[2], ARGV[2])
  return 1
`;
const RENEW_LEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
`;
const RELEASE_LEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  return redis.call('DEL', KEYS[1])
`;

type KarmaEvaluationCycle = {
  cursor: string | null;
  startedAt: number;
  nextRunAt: number;
};

export type KarmaEvaluationResult = {
  evaluated: boolean;
  selected: number;
  dirtySelected: number;
  sweepSelected: number;
  updated: number;
  cycleComplete: boolean;
  nextRunAt: number | null;
};

type KarmaEvaluationRow = {
  uid: string;
  role: string;
  karma: number | string;
  points: number | string;
  created_at: string;
  last_active: string;
  approved_images: number | string | null;
  rejected_images: number | string | null;
};

function idleResult(cycle: KarmaEvaluationCycle | null): KarmaEvaluationResult {
  return {
    evaluated: false,
    selected: 0,
    dirtySelected: 0,
    sweepSelected: 0,
    updated: 0,
    cycleComplete: cycle?.cursor === null,
    nextRunAt: cycle?.nextRunAt ?? null
  };
}

export async function evaluateKarmaIfDue(
  db: D1Database,
  redis: Redis
): Promise<KarmaEvaluationResult> {
  return runKarmaEvaluation(db, redis, false);
}

export async function evaluateKarmaBatch(
  db: D1Database,
  redis: Redis
): Promise<KarmaEvaluationResult> {
  return runKarmaEvaluation(db, redis, true);
}

async function runKarmaEvaluation(db: D1Database, redis: Redis, force: boolean): Promise<KarmaEvaluationResult> {
  let cycle = await redis.get<KarmaEvaluationCycle>(KARMA_EVALUATION_CYCLE_KEY);
  if (!force && cycle?.cursor === null && Date.now() < cycle.nextRunAt) return idleResult(cycle);

  const token = crypto.randomUUID();
  const acquired = await redis.set(KARMA_EVALUATION_LEASE_KEY, token, {
    nx: true,
    ex: KARMA_EVALUATION_LEASE_SECONDS
  });
  if (!acquired) return idleResult(cycle);

  try {
    cycle = await redis.get<KarmaEvaluationCycle>(KARMA_EVALUATION_CYCLE_KEY);
    const now = Date.now();
    if (!force && cycle?.cursor === null && now < cycle.nextRunAt) return idleResult(cycle);
    if (!cycle || cycle.cursor === null) {
      cycle = { cursor: "", startedAt: now, nextRunAt: now + getKarmaEvaluationIntervalSeconds() * 1000 };
      await saveCycle(redis, token, cycle);
    }

    const limit = Math.min(1000, getKarmaEvaluationBatchSize());
    const uids = await selectSweepUidsAfter(db, cycle.cursor ?? "", limit);
    const deadline = now + KARMA_EVALUATION_BUDGET_MS;
    let selected = 0;
    let updated = 0;
    for (let index = 0; index < uids.length; index += KARMA_EVALUATION_QUERY_CHUNK_SIZE) {
      if (selected > 0 && Date.now() >= deadline) break;
      const renewed = await redis.eval(RENEW_LEASE_SCRIPT, [KARMA_EVALUATION_LEASE_KEY], [token, KARMA_EVALUATION_LEASE_SECONDS]);
      if (Number(renewed) !== 1) throw new Error("KARMA_EVALUATION_LEASE_LOST");
      const chunk = uids.slice(index, index + KARMA_EVALUATION_QUERY_CHUNK_SIZE);
      updated += await evaluateKarmaUserChunk(db, chunk, new Date(cycle.startedAt));
      selected += chunk.length;
    }

    const cycleComplete = selected === uids.length && uids.length < limit;
    const nextCycle = {
      ...cycle,
      cursor: cycleComplete ? null : uids[selected - 1] ?? cycle.cursor
    };
    await saveCycle(redis, token, nextCycle);
    return {
      evaluated: true,
      selected,
      dirtySelected: 0,
      sweepSelected: selected,
      updated,
      cycleComplete,
      nextRunAt: nextCycle.nextRunAt
    };
  } finally {
    await redis.eval(RELEASE_LEASE_SCRIPT, [KARMA_EVALUATION_LEASE_KEY], [token]).catch((error) => {
      console.warn("[karma] failed to release evaluation lease", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

async function saveCycle(redis: Redis, token: string, cycle: KarmaEvaluationCycle): Promise<void> {
  const saved = await redis.eval(SAVE_CYCLE_SCRIPT,
    [KARMA_EVALUATION_LEASE_KEY, KARMA_EVALUATION_CYCLE_KEY], [token, JSON.stringify(cycle)]);
  if (Number(saved) !== 1) throw new Error("KARMA_EVALUATION_LEASE_LOST");
}

async function evaluateKarmaUserChunk(db: D1Database, uids: string[], evaluatedAt: Date): Promise<number> {
  const selectedUserValues = uids.map((_, index) => `(?${index + 1})`).join(", ");
  const aiStaleNotePlaceholder = `?${uids.length + 1}`;
  const recallNotePlaceholder = `?${uids.length + 2}`;
  const rows = await db
    .prepare(
      `WITH selected_users(uid) AS (
         VALUES ${selectedUserValues}
       ),
       image_stats AS (
         SELECT
           s.user_id,
           SUM(CASE WHEN kind = 'image' AND status IN ('active', 'flagged', 'remove_request') THEN 1 ELSE 0 END) AS approved_images,
           SUM(
             CASE
               WHEN kind = 'image'
                AND status = 'stale'
                AND COALESCE(moderation_note, '') NOT LIKE ${aiStaleNotePlaceholder}
                AND COALESCE(moderation_note, '') NOT LIKE ${recallNotePlaceholder}
               THEN 1
               ELSE 0
             END
           ) AS rejected_images
         FROM selected_users selected
         CROSS JOIN ugc_submissions s INDEXED BY idx_ugc_user_kind_poi_created ON selected.uid = s.user_id
         WHERE s.kind = 'image'
         GROUP BY s.user_id
       )
       SELECT
         u.uid,
         u.role,
         u.karma,
         u.points,
         u.created_at,
         u.last_active,
         COALESCE(s.approved_images, 0) AS approved_images,
         COALESCE(s.rejected_images, 0) AS rejected_images
       FROM users u
       INNER JOIN selected_users selected ON selected.uid = u.uid
       LEFT JOIN image_stats s ON s.user_id = u.uid
       WHERE u.role <> 'r' AND u.karma < 5`
    )
    .bind(...uids, `${AI_STALE_MODERATION_NOTE_PREFIX}%`, `${RECALL_MODERATION_NOTE_PREFIX}%`)
    .all<KarmaEvaluationRow>();

  const updates: D1PreparedStatement[] = [];
  for (const row of rows.results ?? []) {
    const currentKarma = toFiniteNumber(row.karma);
    const score = calculateKarmaEvaluationScore({
      points: toFiniteNumber(row.points),
      createdAt: row.created_at,
      lastActive: row.last_active,
      approvedImages: toFiniteNumber(row.approved_images),
      rejectedImages: toFiniteNumber(row.rejected_images)
    }, evaluatedAt);
    const nextKarma = currentKarma >= 5 ? 5 : pointsToKarma(score);
    if (nextKarma === currentKarma) {
      continue;
    }

    updates.push(db.prepare(
      `UPDATE users SET karma = ?2
       WHERE uid = ?1 AND karma = ?3 AND points = ?4 AND last_active = ?5 AND role = ?6`
    ).bind(row.uid, nextKarma, currentKarma, toFiniteNumber(row.points), row.last_active, row.role));
  }

  if (updates.length === 0) return 0;
  const results = await db.batch(updates);
  return results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
}

function toFiniteNumber(value: number | string | null): number {
  const normalized = Number(value ?? 0);
  return Number.isFinite(normalized) ? normalized : 0;
}

async function selectSweepUidsAfter(db: D1Database, cursor: string, limit: number): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT uid
       FROM users
       WHERE role <> 'r'
         AND karma < 5
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
