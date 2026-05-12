import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createAuth } from "../lib/auth";
import { getRuntimeConfig } from "../lib/config";
import { ApiError } from "../lib/errors";
import { RECALL_MODERATION_NOTE_PREFIX } from "../lib/moderation";
import { createRedisClient } from "../lib/redis";
import { requireAuth, requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import {
  countSubmissionFlags,
  countSubmissionUpvotes,
  createPendingSubmission,
  createSubmissionFlag,
  createSubmissionUpvote,
  deleteSubmissionFlag,
  deleteSubmissionUpvote,
  getPublicSubmissionByFilePath,
  getSubmissionById,
  listActiveImagesByMarker,
  listUserImagesByMarker,
  updateSubmissionStatus
} from "../repositories/submissions";
import { getUserByUid } from "../repositories/users";
import { readImageDimensions } from "../services/image-metadata";
import { enqueueModeration } from "../services/moderation";
import { buildUploadObjectKey, extensionFromMime, normalizePathPart, prepareUploadImageForStorage } from "../services/upload";
import type { AppEnv } from "../types/app";

const imagesQuerySchema = z.object({
  markerId: z.string().min(1).max(128).optional(),
  markerIds: z.string().max(4000).optional(),
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(24).optional()
});

const imageUploadFieldsSchema = z.object({
  markerId: z.string().min(1).max(128),
  poiHash: z.string().min(1).max(128),
  poiType: z.string().min(1).max(128),
  content: z.string().max(1000).optional()
});

const commentSubmissionSchema = z.object({
  markerId: z.string().min(1).max(128),
  poiHash: z.string().min(1).max(128),
  poiType: z.string().min(1).max(128),
  content: z.string().trim().min(1).max(199)
});

const TEST_UPLOAD_PREFIX = "_test";
const BETA_FRONTEND_HOSTNAMES = new Set([
  "beta.opendfieldmap.org"
]);

function isUploadsLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

function pickString(value: FormDataEntryValue | FormDataEntryValue[] | undefined): string | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  return typeof item === "string" ? item : undefined;
}

function pickFile(value: FormDataEntryValue | FormDataEntryValue[] | undefined): File | null {
  const item = Array.isArray(value) ? value[0] : value;
  return item instanceof File ? item : null;
}

function parseObjectKey(raw: string | undefined): string {
  const key = raw?.trim() ?? "";
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\")) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
  }
  return key;
}

function parseObjectKeyFromRequestPath(path: string): string {
  const publicMarker = "/uploads/v1/public-file/";
  const localPublicMarker = "/public-file/";
  const publicMarkerIndex = path.indexOf(publicMarker);
  if (publicMarkerIndex >= 0) {
    try {
      return parseObjectKey(decodeURIComponent(path.slice(publicMarkerIndex + publicMarker.length)));
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
    }
  }
  if (path.startsWith(localPublicMarker)) {
    try {
      return parseObjectKey(decodeURIComponent(path.slice(localPublicMarker.length)));
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
    }
  }

  const marker = "/uploads/v1/file/";
  const localMarker = "/file/";
  const markerIndex = path.indexOf(marker);
  const raw = markerIndex >= 0
    ? path.slice(markerIndex + marker.length)
    : path.startsWith(localMarker)
      ? path.slice(localMarker.length)
      : "";

  try {
    return parseObjectKey(decodeURIComponent(raw));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isBetaFrontendRequest(request: Request): boolean {
  const candidates = [request.headers.get("origin"), request.headers.get("referer")];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const url = new URL(candidate);
      if (BETA_FRONTEND_HOSTNAMES.has(url.hostname.toLowerCase())) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function resolveUploadPrefix(request: Request, configuredPrefix: string): string {
  if (isBetaFrontendRequest(request)) {
    return TEST_UPLOAD_PREFIX;
  }
  return configuredPrefix;
}

function resolveImageScope(
  request: Request,
  configuredPrefix: string,
  scope: "test" | "prod" | undefined
): { pathPrefix?: string; excludePathPrefix?: string } {
  if (isBetaFrontendRequest(request) || configuredPrefix === TEST_UPLOAD_PREFIX) {
    return { pathPrefix: TEST_UPLOAD_PREFIX };
  }

  if (scope === "test") {
    return { pathPrefix: TEST_UPLOAD_PREFIX };
  }

  if (scope === "prod") {
    return { excludePathPrefix: TEST_UPLOAD_PREFIX };
  }

  return {};
}

function resolveImageCacheNamespace(scope: { pathPrefix?: string; excludePathPrefix?: string }): string {
  if (scope.pathPrefix === TEST_UPLOAD_PREFIX) {
    return "test";
  }
  if (scope.excludePathPrefix === TEST_UPLOAD_PREFIX) {
    return "prod";
  }
  return "default";
}

function resolvePublicAssetBaseUrl(requestUrl: string, configuredBaseUrl: string): string {
  const url = new URL(requestUrl);
  if (isLocalHostname(url.hostname)) {
    return `${url.origin}/uploads/v1/public-file`;
  }
  return configuredBaseUrl;
}

export function createUploadRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const hasAuthHeaders = Boolean(
      c.req.header("authorization")?.trim() ||
      c.req.header("cookie")?.trim()
    );
    if (hasAuthHeaders) {
      const session = await createAuth(c.env).api.getSession({
        headers: c.req.raw.headers
      });
      if (session) {
        const user = await getUserByUid(c.env.DB, session.user.id);
        if (user?.role === "s") {
          throw new ApiError(
            403,
            "ACCESS_DENIED",
            "Suspended users cannot access upload endpoints."
          );
        }
      }
    }

    const isImageRead = c.req.method === "GET" && (
      c.req.path.endsWith("/uploads/v1/images") ||
      c.req.path.endsWith("/uploads/v1/images/mine") ||
      c.req.path.includes("/uploads/v1/public-file/")
    );
    if (!isImageRead && isUploadsLocked(c.env.LOCK_UPLOAD_ENDPOINTS)) {
      throw new ApiError(
        503,
        "UPLOADS_TEMPORARILY_DISABLED",
        "Upload endpoints are temporarily disabled during stabilization."
      );
    }
    await next();
  });

  app.post("/images", requireAuth, rateLimit("upload"), async (c) => {
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
    const normalizedMime = file.type.toLowerCase();
    if (!config.allowedUploadMime.has(normalizedMime) || extensionFromMime(normalizedMime) === "bin") {
      throw new ApiError(422, "MIME_NOT_ALLOWED", "File MIME type is not allowed.");
    }

    const body = await file.arrayBuffer();
    if (body.byteLength <= 0 || body.byteLength > config.maxUploadBytes) {
      throw new ApiError(422, "UPLOAD_SIZE_INVALID", "Upload body size is invalid.", {
        maxBytes: config.maxUploadBytes
      });
    }

    const dimensions = readImageDimensions(body, normalizedMime);
    const preparedImage = await prepareUploadImageForStorage({
      body,
      mimeType: normalizedMime,
      dimensions
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
    const objectKey = buildUploadObjectKey({
      poiType,
      poiHash,
      snapshotId,
      mimeType: preparedImage.mimeType,
      prefix: uploadPrefix
    });

    await c.env.UGC_BUCKET.put(objectKey, preparedImage.body, {
      httpMetadata: {
        contentType: preparedImage.mimeType
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
    await enqueueModeration(createRedisClient(c.env), submissionId);

    return c.json({
      ok: true,
      submission: {
        id: submissionId,
        markerId: parsed.data.markerId,
        status: "pending_openai",
        filePath: objectKey,
        snapshotId
      }
    });
  });

  app.post("/comments", requireAuth, rateLimit("upload"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const parsed = commentSubmissionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment payload.", parsed.error.flatten());
    }

    const submissionId = nanoid(18);
    const snapshotId = nanoid(12);
    const poiType = normalizePathPart(parsed.data.poiType);
    const poiHash = normalizePathPart(parsed.data.poiHash);

    await createPendingSubmission(c.env.DB, {
      id: submissionId,
      markerId: parsed.data.markerId,
      poiHash,
      poiType,
      snapshotId,
      userId: user.uid,
      content: parsed.data.content,
      kind: "comment",
      status: "pending_openai"
    });
    await enqueueModeration(createRedisClient(c.env), submissionId);

    return c.json({
      ok: true,
      submission: {
        id: submissionId,
        markerId: parsed.data.markerId,
        status: "pending_openai",
        snapshotId
      }
    });
  });

  app.get("/public-file/*", rateLimit("public"), async (c) => {
    const objectKey = parseObjectKeyFromRequestPath(c.req.path);
    const submission = await getPublicSubmissionByFilePath(c.env.DB, objectKey);
    if (!submission) {
      throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
    }

    const object = await c.env.UGC_BUCKET.get(objectKey);
    if (!object) {
      throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    headers.set("Content-Type", object.httpMetadata?.contentType ?? submission.mimeType ?? "application/octet-stream");

    return new Response(object.body, {
      status: 200,
      headers
    });
  });

  app.get("/images/mine", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const parsed = imagesQuerySchema.safeParse({
      markerId: c.req.query("markerId"),
      markerIds: c.req.query("markerIds"),
      scope: c.req.query("scope"),
      limit: c.req.query("limit")
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
    }

    const markerIds = parsed.data.markerIds
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const ids = markerIds?.length ? markerIds : parsed.data.markerId ? [parsed.data.markerId] : [];
    if (ids.length === 0) {
      throw new ApiError(422, "VALIDATION_ERROR", "markerId or markerIds is required.");
    }

    const config = getRuntimeConfig(c.env);
    const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
    const items = await listUserImagesByMarker(c.env.DB, {
      userId: user.uid,
      markerIds: ids,
      assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
      pathPrefix: scope.pathPrefix,
      excludePathPrefix: scope.excludePathPrefix,
      limit: parsed.data.limit ?? 6
    });

    return c.json({ items });
  });

  app.get("/file/*", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    const objectKey = parseObjectKeyFromRequestPath(c.req.path);
    const object = await c.env.UGC_BUCKET.get(objectKey);
    if (!object) {
      throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "private, max-age=60");
    headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");

    return new Response(object.body, {
      status: 200,
      headers
    });
  });

  app.post("/images/:id/upvote", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    const submissionId = c.req.param("id");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    if (!submissionId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
    }

    const submission = await getSubmissionById(c.env.DB, submissionId);
    if (!submission || submission.kind !== "image") {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
    }
    if (!["active", "flagged", "remove_request"].includes(submission.status)) {
      throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible images can be upvoted.", {
        status: submission.status
      });
    }

    const created = await createSubmissionUpvote(c.env.DB, {
      submissionId,
      userId: user.uid
    });
    const upvoteCount = await countSubmissionUpvotes(c.env.DB, submissionId);

    return c.json({ ok: true, created, upvoteCount });
  });

  app.post("/images/:id/unvote", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    const submissionId = c.req.param("id");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    if (!submissionId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
    }

    const submission = await getSubmissionById(c.env.DB, submissionId);
    if (!submission || submission.kind !== "image") {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
    }
    if (!["active", "flagged", "remove_request"].includes(submission.status)) {
      throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible images can be unvoted.", {
        status: submission.status
      });
    }

    const deleted = await deleteSubmissionUpvote(c.env.DB, {
      submissionId,
      userId: user.uid
    });
    const upvoteCount = await countSubmissionUpvotes(c.env.DB, submissionId);

    return c.json({ ok: true, deleted, upvoteCount });
  });

  app.post("/images/:id/flag", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    const submissionId = c.req.param("id");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    if (!submissionId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
    }

    const submission = await getSubmissionById(c.env.DB, submissionId);
    if (!submission || submission.kind !== "image") {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
    }
    if (submission.userId === user.uid) {
      throw new ApiError(403, "CANNOT_FLAG_OWN_SUBMISSION", "You cannot flag your own image.");
    }
    if (submission.status !== "active" && submission.status !== "flagged") {
      throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only active or flagged images can be flagged.", {
        status: submission.status
      });
    }

    const created = await createSubmissionFlag(c.env.DB, {
      submissionId,
      userId: user.uid
    });
    if (created && submission.status === "active") {
      await updateSubmissionStatus(c.env.DB, {
        id: submissionId,
        status: "flagged",
        moderationNote: "Flagged by user."
      });
    }
    const flagCount = await countSubmissionFlags(c.env.DB, submissionId);

    return c.json({ ok: true, created, status: "flagged", flagCount });
  });

  app.post("/images/:id/unflag", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    const submissionId = c.req.param("id");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    if (!submissionId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
    }

    const submission = await getSubmissionById(c.env.DB, submissionId);
    if (!submission || submission.kind !== "image") {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
    }
    if (submission.userId === user.uid) {
      throw new ApiError(403, "CANNOT_UNFLAG_OWN_SUBMISSION", "You cannot unflag your own image.");
    }
    if (submission.status !== "active" && submission.status !== "flagged") {
      throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only active or flagged images can be unflagged.", {
        status: submission.status
      });
    }

    const deleted = await deleteSubmissionFlag(c.env.DB, {
      submissionId,
      userId: user.uid
    });
    const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
    const status = flagCount > 0 ? "flagged" : "active";
    if (submission.status !== status) {
      await updateSubmissionStatus(c.env.DB, {
        id: submissionId,
        status,
        moderationNote: status === "active" ? "User flag removed." : undefined
      });
    }

    return c.json({ ok: true, deleted, status, flagCount });
  });

  app.post("/images/:id/remove-request", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    const submissionId = c.req.param("id");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    if (!submissionId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
    }

    const submission = await getSubmissionById(c.env.DB, submissionId);
    if (!submission) {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission was not found.");
    }
    if (submission.userId !== user.uid) {
      throw new ApiError(403, "REMOVE_REQUEST_OWNER_ONLY", "Only the uploader can request image removal.");
    }
    if (submission.status !== "active" && submission.status !== "flagged") {
      throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only visible images can receive a remove request.", {
        from: submission.status,
        to: "remove_request"
      });
    }

    await updateSubmissionStatus(c.env.DB, {
      id: submissionId,
      status: "remove_request",
      moderationNote: "Removal requested by uploader."
    });

    return c.json({ ok: true, status: "remove_request" });
  });

  app.post("/images/:id/unrecall", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    const submissionId = c.req.param("id");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    if (!submissionId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
    }

    const submission = await getSubmissionById(c.env.DB, submissionId);
    if (!submission || submission.kind !== "image") {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
    }
    if (submission.userId !== user.uid) {
      throw new ApiError(403, "RECALL_OWNER_ONLY", "Only the uploader can cancel image recall.");
    }
    if (submission.status !== "remove_request") {
      throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only remove requests can be cancelled.", {
        from: submission.status,
        to: "active"
      });
    }

    const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
    const status = flagCount > 0 ? "flagged" : "active";
    await updateSubmissionStatus(c.env.DB, {
      id: submissionId,
      status,
      moderationNote: "Removal request cancelled by uploader."
    });

    return c.json({ ok: true, status, flagCount });
  });

  app.post("/images/:id/recall", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    const submissionId = c.req.param("id");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    if (!submissionId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
    }

    const submission = await getSubmissionById(c.env.DB, submissionId);
    if (!submission || submission.kind !== "image") {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
    }
    if (submission.userId !== user.uid) {
      throw new ApiError(403, "RECALL_OWNER_ONLY", "Only the uploader can recall an image.");
    }
    if (submission.status === "stale") {
      return c.json({ ok: true, status: "stale" });
    }
    if (!["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(submission.status)) {
      throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Image cannot be recalled from its current status.", {
        from: submission.status,
        to: "remove_request"
      });
    }

    await updateSubmissionStatus(c.env.DB, {
      id: submissionId,
      status: "remove_request",
      moderationNote: `${RECALL_MODERATION_NOTE_PREFIX} upload error.`
    });

    return c.json({ ok: true, status: "remove_request" });
  });

  app.get("/images", rateLimit("public"), async (c) => {
    const parsed = imagesQuerySchema.safeParse({
      markerId: c.req.query("markerId"),
      markerIds: c.req.query("markerIds"),
      scope: c.req.query("scope"),
      limit: c.req.query("limit")
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
    }

    const markerIds = parsed.data.markerIds
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const ids = markerIds?.length ? markerIds : parsed.data.markerId ? [parsed.data.markerId] : [];
    if (ids.length === 0) {
      throw new ApiError(422, "VALIDATION_ERROR", "markerId or markerIds is required.");
    }

    const config = getRuntimeConfig(c.env);
    const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
    const session = await createAuth(c.env).api.getSession({
      headers: c.req.raw.headers
    });
    const useSharedCache = !session;
    let cache: Cache | null = null;
    let cacheKey: Request | null = null;
    if (useSharedCache) {
      cache = await caches.open("ugc-images");
      const cacheNamespace = resolveImageCacheNamespace(scope);
      const cacheUrl = new URL(c.req.url);
      cacheUrl.searchParams.set("_cache_ns", cacheNamespace);
      cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const images = await listActiveImagesByMarker(c.env.DB, {
      markerIds: ids,
      assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
      pathPrefix: scope.pathPrefix,
      excludePathPrefix: scope.excludePathPrefix,
      limit: parsed.data.limit ?? 6,
      viewerUserId: session?.user.id
    });

    const response = c.json({ items: images });
    if (cache && cacheKey) {
      response.headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    } else {
      response.headers.set("Cache-Control", "private, max-age=30");
    }
    return response;
  });

  return app;
}
