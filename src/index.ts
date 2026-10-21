import { handleNotificationLiveUpgrade } from "@/routes/notify/liveUpgrade";

import { createApp } from "./app";
import { runWithAuthRequest } from "./lib/auth/createAuth";
import { getRuntimeConfig } from "./lib/config";
import { createRedisClient } from "./lib/redis";
import { evaluateKarmaIfDue } from "./services/karma/evaluation";
import type {
  OemModerationQueueMessage,
  OemTranslationQueueMessage,
  OemWebhookQueueMessage,
} from "./services/moderation/messages";
import { processWebhookQueueBatch } from "./services/moderation/notifications";
import {
  ensureModerationBackfill,
  processModerationQueueBatch,
  processTranslationQueueBatch,
} from "./services/moderation/queue";
import { drainProgressStatsOutbox } from "./services/progress/outbox";
import {
  cleanupProgressConsistencyRecords,
  getProgressStatsOutboxHealth,
} from "./services/progress/repository";
import type { Bindings } from "./types/app";
export { oem_imgTrans } from "./services/upload/imageTranscoderContainer";
export { OEMUserDO } from "./services/progress/userDo";
export { OEMStatsDO } from "./services/progress/statsDo";
export { OEMNotificationDO } from "./services/notify/live";
export { PublicReadCache } from "./publicRead/origin/entrypoint";

const app = createApp();

function isFeatureLocked(flag: string | undefined, defaultLocked = true): boolean {
  if (!flag) {
    return defaultLocked;
  }

  const normalized = flag.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

async function runScheduledJobs(env: Bindings): Promise<void> {
  if (isFeatureLocked(env.LOCK_SCHEDULED_JOBS, false)) {
    console.warn("cron jobs skipped", {
      reason: "LOCK_SCHEDULED_JOBS enabled",
      at: new Date().toISOString(),
    });
    return;
  }

  const redis = createRedisClient(env);
  const config = getRuntimeConfig(env);

  const karmaEvaluation = await evaluateKarmaIfDue(env.DB, redis);
  let enqueued = 0;

  if (config.scheduledModerationEnabled) {
    enqueued = await ensureModerationBackfill(env, 20);
  }

  console.warn("cron jobs completed", {
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
    if (new Date(now).getUTCMinutes() % 5 === 0) {
      const health = await getProgressStatsOutboxHealth(env.DB, now);
      const unhealthy = health.blocked > 0 || health.oldestAgeMs > 5 * 60 * 1_000;
      const log = unhealthy ? console.error : console.warn;
      log("[progress][outbox] health", health);
    }
  } catch (error) {
    console.error("[progress][outbox] recovery failed", {
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    });
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return runWithAuthRequest(async () => {
      const liveResponse = await handleNotificationLiveUpgrade(request, env);
      return liveResponse ?? app.fetch(request, env, ctx);
    });
  },
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runProgressRecovery(env));
    ctx.waitUntil(runScheduledJobs(env));
  },
  async queue(
    batch: MessageBatch<
      OemModerationQueueMessage | OemTranslationQueueMessage | OemWebhookQueueMessage
    >,
    env: Bindings,
  ) {
    if (batch.queue === "oem-moderation") {
      await processModerationQueueBatch(env, batch as MessageBatch<OemModerationQueueMessage>);
      return;
    }
    if (batch.queue === "oem-translation") {
      await processTranslationQueueBatch(env, batch as MessageBatch<OemTranslationQueueMessage>);
      return;
    }
    if (batch.queue === "oem-webhook") {
      await processWebhookQueueBatch(env, batch as MessageBatch<OemWebhookQueueMessage>);
      return;
    }

    console.warn("unknown queue batch received", {
      queue: batch.queue,
      messages: batch.messages.length,
    });
    batch.retryAll();
  },
};
