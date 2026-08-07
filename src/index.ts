import { createRedisClient } from './lib/redis';
import { getRuntimeConfig } from './lib/config';
import { evaluateKarmaIfDue } from './services/karma/evaluation';
import { createApp } from './app';
import { handleNotificationLiveUpgrade } from './routes/notify';
import type { Bindings } from './types/app';
import { initResend } from './lib/email/sender';
import {
  ensureModerationBackfill,
  processModerationQueueBatch,
  processTranslationQueueBatch,
} from './services/moderation/queue';
import { processWebhookQueueBatch } from './services/moderation/notifications';
import type {
  OemModerationQueueMessage,
  OemTranslationQueueMessage,
  OemWebhookQueueMessage,
} from './services/moderation/messages';
import { drainProgressStatsOutbox } from './services/progress/outbox';
import {
  cleanupProgressConsistencyRecords,
  getProgressStatsOutboxHealth,
} from './services/progress/repository';
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
  OEMNotificationDO,
} from './services/notify/live';
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

async function runProgressRecovery(env: Bindings): Promise<void> {
  const now = Date.now();
  try {
    await drainProgressStatsOutbox(env);
    if (new Date(now).getUTCMinutes() === 0) {
      await cleanupProgressConsistencyRecords(env.DB, now);
    }
    const health = await getProgressStatsOutboxHealth(env.DB, now);
    const unhealthy = health.blocked > 0 || health.oldestAgeMs > 5 * 60 * 1_000;
    const log = unhealthy ? console.error : console.warn;
    log('[progress][outbox] health', health);
  } catch (error) {
    console.error('[progress][outbox] recovery failed', {
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    });
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const liveResponse = await handleNotificationLiveUpgrade(request, env);
    return liveResponse ?? app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    initResend(env);
    ctx.waitUntil(runProgressRecovery(env));
    ctx.waitUntil(runScheduledJobs(env));
  },
  async queue(
    batch: MessageBatch<OemModerationQueueMessage | OemTranslationQueueMessage | OemWebhookQueueMessage>,
    env: Bindings
  ) {
    if (batch.queue === 'oem-moderation') {
      await processModerationQueueBatch(env, batch as MessageBatch<OemModerationQueueMessage>);
      return;
    }
    if (batch.queue === 'oem-translation') {
      await processTranslationQueueBatch(env, batch as MessageBatch<OemTranslationQueueMessage>);
      return;
    }
    if (batch.queue === 'oem-webhook') {
      await processWebhookQueueBatch(env, batch as MessageBatch<OemWebhookQueueMessage>);
      return;
    }

    console.warn('unknown queue batch received', {
      queue: batch.queue,
      messages: batch.messages.length,
    });
    batch.retryAll();
  },
};
