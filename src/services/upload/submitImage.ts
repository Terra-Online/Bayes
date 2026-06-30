import { nanoid } from "nanoid";
import { getRuntimeConfig } from "../../lib/config";
import { ApiError } from "../../lib/errors";
import { UGC_PUBLIC_IMAGE_CACHE_CONTROL } from "../../middleware/cache/publicUgcAssets";
import { getDuplicateImageMarkerSummary } from "../../repositories/submission-duplicates";
import { createPendingSubmission } from "../../repositories/submission/createSubmission";
import { enqueueModeration } from "../moderation/queue";
import type { AppEnv } from "../../types/app";
import { pickFile, pickString, normalizeUploadMime } from "./helpers";
import { imageUploadFieldsSchema } from "./schemas";
import { buildUploadObjectKey, extensionFromMime, normalizePathPart, prepareUploadImageForStorage } from "./storage";
import { resolveImageScope, resolveUploadPrefix } from "./scope";

export async function handleSubmitImage(c: import("hono").Context<AppEnv>) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }

  const form = await c.req.parseBody();
  const file = pickFile(form.file) ?? pickFile(form.image);
  if (!file) {
    throw new ApiError(422, "UPLOAD_FILE_MISSING", "Image file is required.");
  }

  const parsed = imageUploadFieldsSchema.safeParse({
    markerId: pickString(form.markerId),
    poiHash: pickString(form.poiHash),
    poiType: pickString(form.poiType),
    content: pickString(form.content)
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid upload payload.", parsed.error.flatten());
  }

  const config = getRuntimeConfig(c.env);
  const normalizedMime = normalizeUploadMime(file);
  if (!config.allowedUploadMime.has(normalizedMime) || extensionFromMime(normalizedMime) === "bin") {
    throw new ApiError(422, "MIME_NOT_ALLOWED", "File MIME type is not allowed.");
  }

  const body = await file.arrayBuffer();
  if (body.byteLength <= 0 || body.byteLength > config.maxUploadBytes) {
    throw new ApiError(422, "UPLOAD_SIZE_INVALID", "Upload body size is invalid.", {
      maxBytes: config.maxUploadBytes
    });
  }

  const preparedImage = await prepareUploadImageForStorage({
    body,
    mimeType: normalizedMime,
    transcoder: c.env.OEM_IMG_TRANS
  }).catch((error) => {
    throw new ApiError(422, "IMAGE_PROCESSING_FAILED", "Image could not be processed.", {
      reason: error instanceof Error ? error.message : "unknown"
    });
  });
  if (preparedImage.sizeBytes <= 0 || preparedImage.sizeBytes > config.maxUploadBytes) {
    throw new ApiError(422, "UPLOAD_SIZE_INVALID", "Upload body size is invalid after processing.", {
      maxBytes: config.maxUploadBytes
    });
  }

  const submissionId = nanoid(18);
  const snapshotId = nanoid(12);
  const poiType = normalizePathPart(parsed.data.poiType);
  const poiHash = normalizePathPart(parsed.data.poiHash);
  const uploadPrefix = resolveUploadPrefix(c.req.raw, config.ugcUploadPathPrefix);
  const uploadScope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, undefined);
  const objectKey = buildUploadObjectKey({
    poiType,
    poiHash,
    snapshotId,
    mimeType: preparedImage.mimeType,
    prefix: uploadPrefix
  });

  await c.env.UGC_BUCKET.put(objectKey, preparedImage.body, {
    httpMetadata: {
      contentType: preparedImage.mimeType,
      cacheControl: UGC_PUBLIC_IMAGE_CACHE_CONTROL
    },
    customMetadata: {
      sourceMimeType: normalizedMime,
      convertedToWebp: preparedImage.converted ? "true" : "false"
    }
  });

  await createPendingSubmission(c.env.DB, {
    id: submissionId,
    markerId: parsed.data.markerId,
    poiHash,
    poiType,
    snapshotId,
    userId: user.uid,
    content: parsed.data.content,
    kind: "image",
    filePath: objectKey,
    mimeType: preparedImage.mimeType,
    sizeBytes: preparedImage.sizeBytes,
    status: "pending_openai"
  });
  await enqueueModeration(c.env, submissionId);
  const duplicatePoi = await getDuplicateImageMarkerSummary(c.env.DB, {
    markerId: parsed.data.markerId,
    pathPrefix: uploadScope.pathPrefix,
    excludePathPrefix: uploadScope.excludePathPrefix
  });

  return c.json({
    ok: true,
    submission: {
      id: submissionId,
      markerId: parsed.data.markerId,
      status: "pending_openai",
      filePath: objectKey,
      snapshotId
    },
    duplicatePoi: duplicatePoi
      ? {
          markerId: duplicatePoi.markerId,
          imageCount: duplicatePoi.imageCount,
          dashboardPath: `/ugc-review?duplicateMarker=${encodeURIComponent(duplicatePoi.markerId)}`
        }
      : null
  });
}
