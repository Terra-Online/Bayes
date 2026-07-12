import type { Redis } from "@upstash/redis";
import {
  AI_ACTIVE_MODERATION_NOTE_PREFIX,
  AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX,
  COMMENT_EDIT_MODERATION_NOTE_PREFIX
} from "../../lib/moderation";
import { deletePublicMarkerCommentCache } from "../../middleware/cache/publicMarkerComments";
import { deletePublicMarkerImageCache } from "../../middleware/cache/publicMarkerImages";
import { prewarmPublicUgcAsset } from "../../middleware/cache/publicUgcAssets";
import { markKarmaDirty } from "../karma/evaluation";
import { getModerationPointsDeltaWithDailyBackoff } from "../karma/moderationPoints";
import {
  createEmptyPendingOpenAICompletionStats,
  recordPendingOpenAICompletionStatus
} from "./notifications";
import type { PendingOpenAICompletionStats } from "./messages";
import {
  getSubmissionById,
  updateSubmissionStatusForSnapshot
} from "../../repositories/submission/statusSubmission";
import type { SubmissionRecord, SubmissionStatus } from "../../repositories/submission/types";
import { applyUserPointsDelta } from "../../repositories/users";

const OPENAI_MODERATION_TIMEOUT_MS = 8_000;

interface OpenAIModerationResult {
  approved: boolean;
  flagged: boolean;
  categorySummary: string;
}

export interface ModerationProcessResult {
  processed: number;
  stats: PendingOpenAICompletionStats;
}

type TransPrewarm = (submissionId: string) => Promise<void>;
type SubmissionModerationNotice = (
  submission: SubmissionRecord,
  prevStatus: SubmissionStatus,
  nextStatus: "active" | "pending_audit"
) => Promise<void>;

interface ModOptions {
  openAiApiKey?: string;
  assetBaseUrl: string;
  ugcBucket: R2Bucket;
  ugcKv?: KVNamespace;
  redis?: Redis;
  surgeModeEnabled?: boolean;
  surgeBackoffMultiplier?: number;
  skipAiModeration?: boolean;
  localAutoApprove?: boolean;
  prewarmAsset?: typeof prewarmPublicUgcAsset;
  enqueueApprovedCommentTransPrewarm?: TransPrewarm;
  enqueueSubmissionModerationNotice?: SubmissionModerationNotice;
}

interface ApplyStatusOptions extends Omit<ModOptions, "openAiApiKey" | "ugcBucket" | "skipAiModeration" | "localAutoApprove"> {
  id: string;
  moderationNote: string;
}

export async function moderateSubmissionIds(
  db: D1Database,
  options: ModOptions,
  submissionIds: string[],
  maxRuntimeMs = 25_000
): Promise<ModerationProcessResult> {
  const stats = createEmptyPendingOpenAICompletionStats();
  const startedAt = Date.now();
  const ids = [...new Set(submissionIds.map((id) => id.trim()).filter(Boolean))];

  for (const submissionId of ids) {
    if (Date.now() - startedAt >= maxRuntimeMs) {
      break;
    }

    const status = await moderateSubmissionById(db, submissionId, options);
    if (status) {
      recordPendingOpenAICompletionStatus(stats, status);
    }
  }

  return {
    processed: stats.processed,
    stats
  };
}

export async function moderateSubmissionById(
  db: D1Database,
  submissionId: string,
  options: ModOptions,
  expectedSnapshotId?: string
): Promise<SubmissionStatus | null> {
  const submission = await getSubmissionById(db, submissionId);
  if (
    !submission ||
    submission.status !== "pending_openai" ||
    (expectedSnapshotId && submission.snapshotId !== expectedSnapshotId)
  ) {
    return null;
  }

  if (options.skipAiModeration) {
    const applied = await applyModerationStatus(db, submission, "pending_audit", {
      assetBaseUrl: options.assetBaseUrl,
      ugcKv: options.ugcKv,
      redis: options.redis,
      surgeModeEnabled: options.surgeModeEnabled,
      surgeBackoffMultiplier: options.surgeBackoffMultiplier,
      prewarmAsset: options.prewarmAsset,
      enqueueApprovedCommentTransPrewarm: options.enqueueApprovedCommentTransPrewarm,
      enqueueSubmissionModerationNotice: options.enqueueSubmissionModerationNotice,
      id: submissionId,
      moderationNote: "AI moderation skipped; waiting for manual audit."
    });
    return applied ? "pending_audit" : null;
  }

  if (!options.openAiApiKey) {
    const status = options.localAutoApprove ? "active" : "pending_audit";
    const applied = await applyModerationStatus(db, submission, status, {
      assetBaseUrl: options.assetBaseUrl,
      ugcKv: options.ugcKv,
      redis: options.redis,
      surgeModeEnabled: options.surgeModeEnabled,
      surgeBackoffMultiplier: options.surgeBackoffMultiplier,
      prewarmAsset: options.prewarmAsset,
      enqueueApprovedCommentTransPrewarm: options.enqueueApprovedCommentTransPrewarm,
      enqueueSubmissionModerationNotice: options.enqueueSubmissionModerationNotice,
      id: submissionId,
      moderationNote: options.localAutoApprove
        ? "Local upload debug auto-approved (OPENAI_API_KEY missing)."
        : "OpenAI moderation skipped in local mode; waiting for manual audit."
    });
    return applied ? status : null;
  }

  let result: OpenAIModerationResult;
  try {
    const imageUrl = submission.kind === "image" && submission.filePath
      ? await resolveModerationImageUrl(options.ugcBucket, {
          filePath: submission.filePath,
          mimeType: submission.mimeType,
          fallbackUrl: `${options.assetBaseUrl.replace(/\/$/, "")}/${submission.filePath}`
        })
      : undefined;

    result = await callOpenAIModeration(options.openAiApiKey, {
      text: submission.content ?? "",
      imageUrl,
      clientRequestId: `moderation:${submissionId}:${submission.snapshotId}`
    });
  } catch (error) {
    result = {
      approved: false,
      flagged: false,
      categorySummary: `OpenAI moderation failed (${formatModerationError(error)}), sent to manual audit.`
    };
  }

  const status = result.approved ? "active" : "pending_audit";
  const applied = await applyModerationStatus(db, submission, status, {
    assetBaseUrl: options.assetBaseUrl,
    ugcKv: options.ugcKv,
    redis: options.redis,
    surgeModeEnabled: options.surgeModeEnabled,
    surgeBackoffMultiplier: options.surgeBackoffMultiplier,
    prewarmAsset: options.prewarmAsset,
    enqueueApprovedCommentTransPrewarm: options.enqueueApprovedCommentTransPrewarm,
    enqueueSubmissionModerationNotice: options.enqueueSubmissionModerationNotice,
    id: submissionId,
    moderationNote: result.approved
      ? `${AI_ACTIVE_MODERATION_NOTE_PREFIX} ${result.categorySummary}`
      : `${AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX} ${result.categorySummary}`
  });
  return applied ? status : null;
}

async function applyModerationStatus(
  db: D1Database,
  submission: SubmissionRecord,
  status: SubmissionStatus,
  options: ApplyStatusOptions
): Promise<boolean> {
  const updated = await updateSubmissionStatusForSnapshot(db, {
    id: options.id,
    snapshotId: submission.snapshotId,
    fromStatus: submission.status,
    status,
    moderationNote: options.moderationNote
  });
  if (!updated) {
    return false;
  }

  if (status === "active" || status === "pending_audit") {
    await options.enqueueSubmissionModerationNotice?.(submission, submission.status, status).catch((error) => {
      console.warn("submission moderation notification enqueue failed", {
        submissionId: options.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  if (status !== "active") {
    return true;
  }

  if (submission.kind === "image") {
    await (options.prewarmAsset ?? prewarmPublicUgcAsset)(options.assetBaseUrl, submission.filePath);
    await deletePublicMarkerImageCache(options.ugcKv, submission.markerId);
  } else {
    await deletePublicMarkerCommentCache(options.ugcKv, submission.markerId);
    await options.enqueueApprovedCommentTransPrewarm?.(options.id);
  }

  const isPreviouslyApprovedEdit = (
    submission.moderationNote?.startsWith(COMMENT_EDIT_MODERATION_NOTE_PREFIX) &&
    submission.editOriginalStatus !== "pending_openai" &&
    submission.editOriginalStatus !== "pending_audit"
  );
  const pointsDelta = isPreviouslyApprovedEdit
    ? 0
    : await getModerationPointsDeltaWithDailyBackoff(options.redis, {
      userId: submission.userId,
      kind: submission.kind,
      status,
      role: submission.submitter?.role,
      surgeModeEnabled: options.surgeModeEnabled,
      surgeBackoffMultiplier: options.surgeBackoffMultiplier
    });
  await applyUserPointsDelta(db, submission.userId, pointsDelta);
  if (options.redis) {
    await markKarmaDirty(options.redis, submission.userId);
  }
  return true;
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
  payload: { text: string; imageUrl?: string; clientRequestId?: string }
): Promise<OpenAIModerationResult> {
  const input = [
    payload.text ? { type: "text", text: payload.text } : null,
    payload.imageUrl ? { type: "image_url", image_url: { url: payload.imageUrl } } : null
  ].filter(Boolean);

  if (input.length === 0) {
    return {
      approved: false,
      flagged: false,
      categorySummary: "empty moderation input; sent to manual audit."
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODERATION_TIMEOUT_MS);

  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(payload.clientRequestId ? { "X-Client-Request-Id": payload.clientRequestId } : {})
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input
    })
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") ?? "unknown";
    const responseText = await response.text().catch(() => "");
    const responseDetail = parseOpenAIErrorDetail(responseText);
    console.warn("OpenAI moderation request failed", {
      status: response.status,
      requestId,
      clientRequestId: payload.clientRequestId ?? null,
      detail: responseDetail
    });
    return {
      approved: false,
      flagged: false,
      categorySummary: `OpenAI moderation unavailable (${response.status}, request_id=${requestId}${responseDetail ? `, ${responseDetail}` : ""}), sent to manual audit.`
    };
  }

  const data = (await response.json()) as {
    results?: Array<{
      flagged?: boolean;
      categories?: Record<string, boolean>;
    }>;
  };

  const first = data.results?.[0];
  if (!first || typeof first.flagged !== "boolean") {
    return {
      approved: false,
      flagged: false,
      categorySummary: "OpenAI moderation returned no explicit decision; sent to manual audit."
    };
  }

  const flagged = Boolean(first?.flagged);
  const categories = first?.categories ?? {};
  const activeCategories = Object.entries(categories)
    .filter(([, active]) => Boolean(active))
    .map(([name]) => name)
    .join(", ");

  return {
    approved: !flagged,
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

function parseOpenAIErrorDetail(raw: string): string {
  if (!raw.trim()) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        code?: string;
        message?: string;
        type?: string;
      };
    };
    const parts = [
      parsed.error?.type,
      parsed.error?.code,
      parsed.error?.message
    ].filter((item): item is string => Boolean(item && item.trim().length > 0));
    return parts.join(": ");
  } catch {
    return raw.slice(0, 240).replace(/\s+/g, " ").trim();
  }
}
