import { createRedisClient } from './lib/redis';
import { flushDirtyProgressToD1 } from './services/progress';
import { ensureModerationBackfill, moderateSubmissionOnce } from './services/moderation';
import { createApp } from './app';
import type { Bindings } from './types/app';
import { initResend } from './lib/email';

const app = createApp();

function isFeatureLocked(flag: string | undefined, defaultLocked = true): boolean {
  if (!flag) {
    return defaultLocked;
  }

  const normalized = flag.trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

async function runScheduledJobs(env: Bindings): Promise<void> {
  if (isFeatureLocked(env.LOCK_SCHEDULED_JOBS, true)) {
    console.warn('cron jobs skipped', {
      reason: 'LOCK_SCHEDULED_JOBS enabled',
      at: new Date().toISOString(),
    });
    return;
  }

  const redis = createRedisClient(env);

  const flushed = await flushDirtyProgressToD1(env.DB, redis, 100);
  const enqueued = await ensureModerationBackfill(env.DB, redis, 20);
  const processed = await moderateSubmissionOnce(env.DB, redis, env.OPENAI_API_KEY, 10);

  console.warn('cron jobs completed', {
    flushed,
    enqueued,
    processed,
    at: new Date().toISOString(),
  });
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) {
    initResend(env);
    await runScheduledJobs(env);
  },
};
