import type { Redis } from "@upstash/redis";
import {
  getPendingSubmissions,
  getSubmissionById,
  updateSubmissionStatus
} from "../repositories/submissions";

const MODERATION_QUEUE_KEY = "moderation:queue";

interface OpenAIModerationResult {
  flagged: boolean;
  categorySummary: string;
}

export async function enqueueModeration(redis: Redis, submissionId: string): Promise<void> {
  await redis.rpush(MODERATION_QUEUE_KEY, submissionId);
}

export async function moderateSubmissionOnce(
  db: D1Database,
  redis: Redis,
  openAiApiKey: string | undefined,
  maxJobs = 10
): Promise<number> {
  let processed = 0;

  for (let i = 0; i < maxJobs; i += 1) {
    const submissionId = await redis.lpop<string>(MODERATION_QUEUE_KEY);
    if (!submissionId) {
      break;
    }

    const submission = await getSubmissionById(db, submissionId);
    if (!submission || submission.auditStatus !== 0) {
      continue;
    }

    if (!openAiApiKey) {
      await updateSubmissionStatus(db, {
        id: submissionId,
        auditStatus: 1,
        moderationNote: "Moderation skipped in local mode (OPENAI_API_KEY missing)."
      });
      processed += 1;
      continue;
    }

    const result = await callOpenAIModeration(openAiApiKey, {
      text: submission.content ?? "",
      imageKey: submission.imageR2Key
    });

    await updateSubmissionStatus(db, {
      id: submissionId,
      auditStatus: result.flagged ? 2 : 1,
      moderationNote: result.categorySummary
    });
    processed += 1;
  }

  return processed;
}

async function callOpenAIModeration(
  apiKey: string,
  payload: { text: string; imageKey: string }
): Promise<OpenAIModerationResult> {
  const input = [payload.text, `image_key:${payload.imageKey}`].filter(Boolean).join("\n");

  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input
    })
  });

  if (!response.ok) {
    return {
      flagged: false,
      categorySummary: `OpenAI moderation unavailable (${response.status}), fallback pass.`
    };
  }

  const data = (await response.json()) as {
    results?: Array<{
      flagged?: boolean;
      categories?: Record<string, boolean>;
    }>;
  };

  const first = data.results?.[0];
  const flagged = Boolean(first?.flagged);
  const categories = first?.categories ?? {};
  const activeCategories = Object.entries(categories)
    .filter(([, active]) => Boolean(active))
    .map(([name]) => name)
    .join(", ");

  return {
    flagged,
    categorySummary: activeCategories || (flagged ? "flagged" : "clean")
  };
}

export async function ensureModerationBackfill(
  db: D1Database,
  redis: Redis,
  targetQueueSize = 20
): Promise<number> {
  const currentLength = await redis.llen(MODERATION_QUEUE_KEY);
  if (typeof currentLength === "number" && currentLength >= targetQueueSize) {
    return 0;
  }

  const pending = await getPendingSubmissions(db, targetQueueSize);
  let enqueued = 0;
  for (const item of pending) {
    await enqueueModeration(redis, item.id);
    enqueued += 1;
  }

  return enqueued;
}
