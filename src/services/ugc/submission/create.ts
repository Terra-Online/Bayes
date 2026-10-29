import { nanoid } from "nanoid";

import { getRuntimeConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { enqueueAutoModeration } from "@/queues/client/autoModeration";
import { getDuplicateImageMarkerSummary } from "@/repositories/submission-duplicates";
import {
  createPendingImage,
  markImageModerationQueued,
} from "@/repositories/submission/createImage";
import { createPendingSubmission } from "@/repositories/submission/createSubmission";
import { getSubmissionById } from "@/repositories/submission/statusSubmission";
import { UGC_PUBLIC_IMAGE_CACHE_CONTROL } from "@/services/ugc/contract/imageDelivery";
import type { ImageReadScope } from "@/services/ugc/contract/imageScope";
import type { AuthUser, Bindings } from "@/types/app";

import {
  buildUploadObjectKey,
  extensionFromMime,
  prepareUploadImageForStorage,
} from "./imagePreparation";
import { normalizeUploadMime } from "./mime";

// Submission compatibility rule for poiType/poiHash. The normalized values are
// stored in D1, matched against reply parents, and used in image object keys.
function normalizePoiField(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 96) || "unknown"
  );
}

interface SubmitCommentInput {
  actor: AuthUser;
  markerId: string;
  poiHash: string;
  poiType: string;
  content: string;
  parentId?: string;
}

export async function submitComment(bindings: Bindings, input: SubmitCommentInput) {
  const submissionId = nanoid(18);
  const snapshotId = nanoid(12);
  const poiType = normalizePoiField(input.poiType);
  const poiHash = normalizePoiField(input.poiHash);
  let parentId: string | null = null;
  let commentDepth = 0;

  if (input.parentId) {
    const parent = await getSubmissionById(bindings.DB, input.parentId);
    if (!parent || parent.kind !== "comment") {
      throw new ApiError(404, "PARENT_COMMENT_NOT_FOUND", "Parent comment was not found.");
    }
    if (
      parent.markerId !== input.markerId ||
      parent.poiHash !== poiHash ||
      parent.poiType !== poiType
    ) {
      throw new ApiError(
        409,
        "PARENT_COMMENT_MISMATCH",
        "Parent comment belongs to a different POI.",
      );
    }
    if (!["active", "flagged", "remove_request"].includes(parent.status)) {
      throw new ApiError(
        409,
        "PARENT_COMMENT_NOT_VISIBLE",
        "Replies can only target visible comments.",
        {
          status: parent.status,
        },
      );
    }
    parentId = parent.id;
    commentDepth = parent.commentDepth + 1;
  }

  await createPendingSubmission(bindings.DB, {
    id: submissionId,
    markerId: input.markerId,
    poiHash,
    poiType,
    snapshotId,
    userId: input.actor.uid,
    content: input.content,
    kind: "comment",
    status: "pending_openai",
    parentId,
    commentDepth,
  });
  await enqueueAutoModeration(bindings, submissionId, snapshotId);

  return {
    submission: {
      id: submissionId,
      markerId: input.markerId,
      parentId,
      depth: commentDepth,
      status: "pending_openai" as const,
      snapshotId,
    },
  };
}
interface SubmitImageInput {
  actor: AuthUser;
  file: File;
  markerId: string;
  poiHash: string;
  poiType: string;
  content?: string;
  uploadPrefix: string;
  scope: ImageReadScope;
  signal: AbortSignal;
  requestId?: string;
}

export async function submitImage(bindings: Bindings, input: SubmitImageInput) {
  const config = getRuntimeConfig(bindings);
  const normalizedMime = normalizeUploadMime(input.file);
  if (
    !config.allowedUploadMime.has(normalizedMime) ||
    extensionFromMime(normalizedMime) === "bin"
  ) {
    throw new ApiError(422, "MIME_NOT_ALLOWED", "File MIME type is not allowed.");
  }

  const body = await input.file.arrayBuffer();
  if (body.byteLength <= 0 || body.byteLength > config.maxUploadBytes) {
    throw new ApiError(422, "UPLOAD_SIZE_INVALID", "Upload body size is invalid.", {
      maxBytes: config.maxUploadBytes,
    });
  }

  const preparedImage = await prepareUploadImageForStorage({
    body,
    mimeType: normalizedMime,
    transcoder: bindings.OEM_IMG_TRANS,
    signal: input.signal,
    requestId: input.requestId,
  });
  if (preparedImage.sizeBytes <= 0 || preparedImage.sizeBytes > config.maxUploadBytes) {
    throw new ApiError(
      422,
      "UPLOAD_SIZE_INVALID",
      "Upload body size is invalid after processing.",
      {
        maxBytes: config.maxUploadBytes,
      },
    );
  }

  const submissionId = nanoid(18);
  const snapshotId = nanoid(12);
  const poiType = normalizePoiField(input.poiType);
  const poiHash = normalizePoiField(input.poiHash);
  const objectKey = buildUploadObjectKey({
    poiType,
    poiHash,
    snapshotId,
    mimeType: preparedImage.mimeType,
    prefix: input.uploadPrefix,
  });

  input.signal.throwIfAborted();
  // Preserve the existing storage -> database -> queue order. Later failures do
  // not roll back earlier writes; this extraction does not add compensation.
  await bindings.UGC_BUCKET.put(objectKey, preparedImage.body, {
    httpMetadata: {
      contentType: preparedImage.mimeType,
      cacheControl: UGC_PUBLIC_IMAGE_CACHE_CONTROL,
    },
    customMetadata: {
      sourceMimeType: normalizedMime,
      convertedToWebp: preparedImage.converted ? "true" : "false",
    },
  });

  await createPendingImage(bindings.DB, {
    id: submissionId,
    markerId: input.markerId,
    poiHash,
    poiType,
    snapshotId,
    userId: input.actor.uid,
    content: input.content,
    filePath: objectKey,
    mimeType: preparedImage.mimeType,
    sizeBytes: preparedImage.sizeBytes,
  });
  const queuedAt = new Date().toISOString();
  await bindings.OEM_MODERATION_Q.send({
    type: "moderation",
    submissionId,
    snapshotId,
    source: "upload",
    queuedAt,
  });
  await markImageModerationQueued(bindings.DB, { submissionId, snapshotId, queuedAt }).catch(
    (error) => {
      console.warn("moderation queued marker update failed", {
        submissionId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  const duplicatePoi = await getDuplicateImageMarkerSummary(bindings.DB, {
    markerId: input.markerId,
    pathPrefix: input.scope.pathPrefix,
    excludePathPrefix: input.scope.excludePathPrefix,
  });

  return {
    submission: {
      id: submissionId,
      markerId: input.markerId,
      status: "pending_openai" as const,
      filePath: objectKey,
      snapshotId,
    },
    duplicatePoi,
  };
}
