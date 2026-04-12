import { createRedisClient } from './lib/redis';
import { flushDirtyProgressToD1 } from './services/progress';
import { ensureModerationBackfill, moderateSubmissionOnce } from './services/moderation';
import { createApp } from './app';
import type { Bindings } from './types/app';
import { initResend } from './lib/email';

const app = createApp();

async function runScheduledJobs(env: Bindings): Promise<void> {
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
