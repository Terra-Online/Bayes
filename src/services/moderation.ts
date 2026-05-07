import type { Redis } from "@upstash/redis";
import {
  getPendingOpenAISubmissions,
  getSubmissionById,
  updateSubmissionStatus
} from "../repositories/submissions";

const MODERATION_QUEUE_KEY = "moderation:queue";
const OPENAI_MODERATION_TIMEOUT_MS = 8_000;

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
  options: {
    openAiApiKey?: string;
    assetBaseUrl: string;
    ugcBucket: R2Bucket;
    skipAiModeration?: boolean;
    localAutoApprove?: boolean;
  },
  maxJobs = 10,
  maxRuntimeMs = 25_000
): Promise<number> {
  let processed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < maxJobs; i += 1) {
    if (Date.now() - startedAt >= maxRuntimeMs) {
      break;
    }

    const submissionId = await redis.lpop<string>(MODERATION_QUEUE_KEY);
    if (!submissionId) {
      break;
    }

    const submission = await getSubmissionById(db, submissionId);
    if (!submission || submission.status !== "pending_openai") {
      continue;
    }

    if (options.skipAiModeration) {
      await updateSubmissionStatus(db, {
        id: submissionId,
        status: "pending_audit",
        moderationNote: "AI moderation skipped; waiting for manual audit."
      });
      processed += 1;
      continue;
    }

    if (!options.openAiApiKey) {
      await updateSubmissionStatus(db, {
        id: submissionId,
        status: options.localAutoApprove ? "active" : "pending_audit",
        moderationNote: options.localAutoApprove
          ? "Local upload debug auto-approved (OPENAI_API_KEY missing)."
          : "OpenAI moderation skipped in local mode; waiting for manual audit."
      });
      processed += 1;
      continue;
    }

    let result: OpenAIModerationResult;
    try {
      result = await callOpenAIModeration(options.openAiApiKey, {
        text: submission.content ?? "",
        imageUrl: await resolveModerationImageUrl(options.ugcBucket, {
          filePath: submission.filePath,
          mimeType: submission.mimeType,
          fallbackUrl: `${options.assetBaseUrl.replace(/\/$/, "")}/${submission.filePath}`
        })
      });
    } catch (error) {
      result = {
        flagged: false,
        categorySummary: `OpenAI moderation failed (${formatModerationError(error)}), sent to manual audit.`
      };
    }

    await updateSubmissionStatus(db, {
      id: submissionId,
      status: result.flagged ? "stale" : "pending_audit",
      moderationNote: result.categorySummary
    });
    processed += 1;
  }

  return processed;
}

async function resolveModerationImageUrl(
  bucket: R2Bucket,
  payload: { filePath: string; mimeType: string | null; fallbackUrl: string }
): Promise<string> {
  const object = await bucket.get(payload.filePath);
  if (!object) {
    return payload.fallbackUrl;
  }

  const mimeType = object.httpMetadata?.contentType ?? payload.mimeType ?? "application/octet-stream";
  const body = await object.arrayBuffer();
  return `data:${mimeType};base64,${arrayBufferToBase64(body)}`;
}

function arrayBufferToBase64(body: ArrayBuffer): string {
  const bytes = new Uint8Array(body);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function callOpenAIModeration(
  apiKey: string,
  payload: { text: string; imageUrl: string }
): Promise<OpenAIModerationResult> {
  const input = [
    payload.text ? { type: "text", text: payload.text } : null,
    { type: "image_url", image_url: { url: payload.imageUrl } }
  ].filter(Boolean);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODERATION_TIMEOUT_MS);

  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input
    })
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    return {
      flagged: false,
      categorySummary: `OpenAI moderation unavailable (${response.status}), sent to manual audit.`
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

function formatModerationError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "timeout" : error.message;
  }
  return "unknown error";
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

  const pending = await getPendingOpenAISubmissions(db, targetQueueSize);
  let enqueued = 0;
  for (const item of pending) {
    await enqueueModeration(redis, item.id);
    enqueued += 1;
  }

  return enqueued;
}
