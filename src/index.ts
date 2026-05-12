import { createRedisClient } from './lib/redis';
import { getRuntimeConfig } from './lib/config';
import { flushDirtyProgressToD1 } from './services/progress';
import { ensureModerationBackfill, moderateSubmissionOnce } from './services/moderation';
import { evaluateKarmaIfDue } from './services/karma';
import { createApp } from './app';
import type { Bindings } from './types/app';
import { initResend } from './lib/email';

const app = createApp();
const MODERATION_FOLLOW_UP_DELAY_MS = 30_000;
const MODERATION_RUN_LOCK_KEY = 'moderation:scheduled:lock';
const MODERATION_RUN_LOCK_TTL_SECONDS = 120;

function isFeatureLocked(flag: string | undefined, defaultLocked = true): boolean {
  if (!flag) {
    return defaultLocked;
  }

  const normalized = flag.trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type ModerationCycleResult = {
  enqueued: number;
  processed: number;
};

async function runModerationCycle(
  env: Bindings,
  redis: ReturnType<typeof createRedisClient>,
  config: ReturnType<typeof getRuntimeConfig>
): Promise<ModerationCycleResult> {
  const enqueued = await ensureModerationBackfill(env.DB, redis, 20);
  const processed = await moderateSubmissionOnce(
    env.DB,
    redis,
    {
      openAiApiKey: env.OPENAI_API_KEY,
      assetBaseUrl: config.ugcAssetBaseUrl,
      ugcBucket: env.UGC_BUCKET,
      redis,
      surgeModeEnabled: config.surgeModeEnabled,
      surgeBackoffMultiplier: config.surgeBackoffMultiplier,
      skipAiModeration: config.skipAiModeration,
      localAutoApprove: config.localUploadAutoApprove,
    },
    10
  );

  return { enqueued, processed };
}

async function runScheduledModeration(
  env: Bindings,
  redis: ReturnType<typeof createRedisClient>,
  config: ReturnType<typeof getRuntimeConfig>
): Promise<ModerationCycleResult> {
  const lockPlaced = await redis.set(MODERATION_RUN_LOCK_KEY, String(Date.now()), {
    nx: true,
    ex: MODERATION_RUN_LOCK_TTL_SECONDS,
  });

  if (!lockPlaced) {
    return { enqueued: 0, processed: 0 };
  }

  try {
    const firstPass = await runModerationCycle(env, redis, config);
    if (firstPass.enqueued === 0 && firstPass.processed === 0) {
      return firstPass;
    }

    await sleep(MODERATION_FOLLOW_UP_DELAY_MS);
    const secondPass = await runModerationCycle(env, redis, config);
    return {
      enqueued: firstPass.enqueued + secondPass.enqueued,
      processed: firstPass.processed + secondPass.processed,
    };
  } finally {
    await redis.del(MODERATION_RUN_LOCK_KEY).catch(() => undefined);
  }
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

  const flushed = await flushDirtyProgressToD1(env.DB, redis, 100);
  const karmaEvaluation = await evaluateKarmaIfDue(env.DB, redis, {
    surgeModeEnabled: config.surgeModeEnabled,
    surgeBackoffMultiplier: config.surgeBackoffMultiplier,
  });
  let enqueued = 0;
  let processed = 0;

  if (config.scheduledModerationEnabled) {
    const moderation = await runScheduledModeration(env, redis, config);
    enqueued = moderation.enqueued;
    processed = moderation.processed;
  }

  console.warn('cron jobs completed', {
    flushed,
    karmaEvaluation,
    enqueued,
    processed,
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
};
