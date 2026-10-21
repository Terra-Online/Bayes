export type PendingSessionRedis = {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options: { ex: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

export async function savePendingRecord(
  redis: PendingSessionRedis,
  key: string,
  session: unknown,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(key, JSON.stringify(session), { ex: ttlSeconds });
}

export async function readPendingRecord(redis: PendingSessionRedis, key: string): Promise<unknown> {
  return redis.get(key);
}

export async function deletePendingRecord(redis: PendingSessionRedis, key: string): Promise<void> {
  await redis.del(key);
}
