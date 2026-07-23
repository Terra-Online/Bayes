import { createRedisClient } from './lib/redis';
import { getRuntimeConfig } from './lib/config';
import { evaluateKarmaIfDue } from './services/karma/evaluation';
import { createApp } from './app';
import type { Bindings } from './types/app';
import { initResend } from './lib/email/sender';
import { ensureModerationBackfill, processModerationQueueBatch } from './services/moderation/queue';
import type { OemModQueueMessage } from './services/moderation/messages';
export {
  oem_imgTrans,
} from './services/upload/imageTranscoderContainer';
export {
  OEMUserDO,
} from './services/progress/userDo';
export {
  OEMStatsDO,
} from './services/progress/statsDo';
export {
  PublicReadCache,
} from './middleware/cache/publicReadCache';

const app = createApp();

function isFeatureLocked(flag: string | undefined, defaultLocked = true): boolean {
  if (!flag) {
    return defaultLocked;
  }

  const normalized = flag.trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

async function runScheduledJobs(env: Bindings): Promise<void> {
  if (isFeatureLocked(env.LOCK_SCHEDULED_JOBS, false)) {
    console.warn('cron jobs skipped', {
      reason: 'LOCK_SCHEDULED_JOBS enabled',
      at: new Date().toISOString(),
    });
    return;
  }

  const redis = createRedisClient(env);
  const config = getRuntimeConfig(env);

  const karmaEvaluation = await evaluateKarmaIfDue(env.DB, redis, {
    surgeModeEnabled: config.surgeModeEnabled,
    surgeBackoffMultiplier: config.surgeBackoffMultiplier,
  });
  let enqueued = 0;

  if (config.scheduledModerationEnabled) {
    enqueued = await ensureModerationBackfill(env, 20);
  }

  console.warn('cron jobs completed', {
    karmaEvaluation,
    enqueued,
    scheduledModerationEnabled: config.scheduledModerationEnabled,
    at: new Date().toISOString(),
  });
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    initResend(env);
    ctx.waitUntil(runScheduledJobs(env));
  },
  async queue(batch: MessageBatch<OemModQueueMessage>, env: Bindings) {
    await processModerationQueueBatch(env, batch);
  },
};
