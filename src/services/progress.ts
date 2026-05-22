import type { Redis } from "@upstash/redis";
import { getUserByUid, updateProgressInD1 } from "../repositories/users";
import { markKarmaDirty } from "./karma";

const PROGRESS_KEY_PREFIX = "user:progress:";
const PROGRESS_DIRTY_SET = "progress:dirty-users";

export interface ProgressData {
  version: number;
  marker: string;
}

function getProgressKey(uid: string): string {
  return `${PROGRESS_KEY_PREFIX}${uid}`;
}

export async function readProgress(
  db: D1Database,
  redis: Redis,
  uid: string,
  ttlSeconds: number
): Promise<ProgressData> {
  const cached = await redis.hgetall<Record<string, string>>(getProgressKey(uid));
  if (cached && cached.version !== undefined && cached.marker !== undefined) {
    return {
      version: Number(cached.version),
      marker: String(cached.marker)
    };
  }

  const user = await getUserByUid(db, uid);
  if (!user) {
    return { version: 0, marker: "" };
  }

  await redis.hset(getProgressKey(uid), {
    version: String(user.progressVersion),
    marker: user.progressMarker
  });
  await redis.expire(getProgressKey(uid), ttlSeconds);

  return {
    version: user.progressVersion,
    marker: user.progressMarker
  };
}

export async function syncProgressToCache(
  redis: Redis,
  uid: string,
  incoming: ProgressData,
  ttlSeconds: number
): Promise<void> {
  await redis.hset(getProgressKey(uid), {
    version: String(incoming.version),
    marker: incoming.marker
  });
  await redis.expire(getProgressKey(uid), ttlSeconds);
  await redis.sadd(PROGRESS_DIRTY_SET, uid);
}

export async function flushDirtyProgressToD1(db: D1Database, redis: Redis, maxUsers = 100): Promise<number> {
  const dirtyUsers = await redis.smembers<string[]>(PROGRESS_DIRTY_SET);
  if (!dirtyUsers || dirtyUsers.length === 0) {
    return 0;
  }

  let flushed = 0;
  for (const uid of dirtyUsers.slice(0, maxUsers)) {
    const progress = await redis.hgetall<Record<string, string>>(getProgressKey(uid));
    if (!progress || progress.version === undefined || progress.marker === undefined) {
      await redis.srem(PROGRESS_DIRTY_SET, uid);
      continue;
    }

    await updateProgressInD1(db, uid, Number(progress.version), String(progress.marker));
    await markKarmaDirty(redis, uid);
    await redis.srem(PROGRESS_DIRTY_SET, uid);
    flushed += 1;
  }

  return flushed;
}
