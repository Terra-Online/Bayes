import type { Context } from "hono";
import { Hono, type MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { nanoid } from "nanoid";

import { getRuntimeConfig, getUgcReadConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import {
  COMMENT_ADMIN_EDIT_MODERATION_NOTE_PREFIX,
  COMMENT_EDIT_MODERATION_NOTE_PREFIX,
  RECALL_MODERATION_NOTE_PREFIX,
} from "@/lib/moderation";
import { prewarmPublicUgcAsset } from "@/lib/publicUgcAssets";
import { resolveContextAuthUser } from "@/middleware/auth";
import { toApiError } from "@/middleware/error-handler";
import { rateLimit } from "@/middleware/rate-limit";
import {
  publicReadResponse,
  readPublicCommentsFromWorkersCache,
  readPublicImagesFromWorkersCache,
} from "@/publicRead/client/client";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import {
  resolvePublicCommentCacheNamespace,
  resolvePublicImageCacheNamespace,
} from "@/publicRead/client/scope";
import { getDuplicateImageMarkerSummary } from "@/repositories/submission-duplicates";
import { createPendingSubmission } from "@/repositories/submission/createSubmission";
import {
  clearSubmissionFlags,
  countSubmissionFlags,
  createSubmissionFlag,
  deleteSubmissionFlag,
} from "@/repositories/submission/flagSubmission";
import { getPublicCommentContextById } from "@/repositories/submission/getPublicComment";
import { getPublicImageById } from "@/repositories/submission/getPublicImage";
import {
  listCommentViewerStateByMarker,
  listUserCommentsByMarker,
} from "@/repositories/submission/listComments";
import {
  listImageViewerReactionsByMarker,
  listUserImagesByMarker,
} from "@/repositories/submission/listImages";
import {
  getImageSubmissionByFilePath,
  getPublicSubmissionByFilePath,
  getSubmissionById,
  revertCommentEdit,
  transitionSubmissionStatusWithNotifications,
  updateCommentContentForModeration,
  updateSubmissionStatus,
} from "@/repositories/submission/statusSubmission";
import type {
  PublicSubmissionComment,
  UserSubmissionComment,
} from "@/repositories/submission/types";
import {
  countSubmissionUpvotes,
  createSubmissionUpvote,
  deleteSubmissionUpvote,
  getSubmissionScore,
  setSubmissionVote,
} from "@/repositories/submission/voteSubmission";
import {
  commentEditSchema,
  commentQuerySchema,
  commentsQuerySchema,
  commentSubmissionSchema,
  commentTranslationSchema,
  imageQuerySchema,
  imagesQuerySchema,
  imageUploadFieldsSchema,
} from "@/routes/schema/uploads";
import {
  notifyFlagCreated,
  notifyFlagRemoved,
  notifyRemoveRequestCancelled,
  notifyRemoveRequestCreated,
} from "@/services/moderation/notifications";
import { enqueueModeration } from "@/services/moderation/queue";
import { publishNotificationsCreated } from "@/services/notify/live";
import { translateVisibleComments } from "@/services/upload/commentTranslation";
import { normalizeUploadMime } from "@/services/upload/mime";
import {
  buildUploadObjectKey,
  extensionFromMime,
  normalizePathPart,
  prepareUploadImageForStorage,
} from "@/services/upload/storage";
import {
  applyCommentViewerReactions,
  applyImageViewerReactions,
} from "@/services/upload/viewerOverlay";
import type { AppEnv, AuthUser } from "@/types/app";

import {
  getOptionalAuthIdentity,
  hasAuthHeaders,
  parseObjectKeyFromRequestPath,
  pickFile,
  pickString,
  requireMarkerIds,
} from "./helpers";
import { UGC_PUBLIC_IMAGE_CACHE_CONTROL } from "./imageDeliveryPolicy";
import {
  resolveImageScope,
  resolvePrivateAssetBaseUrl,
  resolvePublicAssetBaseUrl,
  resolveUploadPrefix,
} from "./scope";

function isUploadsLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

async function assertActiveUser<
  E extends AppEnv<{ authUser?: AuthUser; authUserPromise?: Promise<AuthUser> }>,
>(c: Context<E>): Promise<void> {
  const user = await resolveContextAuthUser(c);
  if (user.role === "s") {
    throw new ApiError(403, "ACCESS_DENIED", "Suspended users cannot access upload endpoints.");
  }
}

const requireActiveUser: MiddlewareHandler<
  AppEnv<{ authUser: AuthUser; authUserPromise?: Promise<AuthUser> }>
> = async (c, next) => {
  await assertActiveUser(c);
  await next();
};

const requireUploadsEnabled: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isUploadsLocked(c.env.LOCK_UPLOAD_ENDPOINTS)) {
    throw new ApiError(
      503,
      "UPLOADS_TEMPORARILY_DISABLED",
      "Upload endpoints are temporarily disabled during stabilization.",
    );
  }
  await next();
};

function requireUserAndSubmissionId<E extends AppEnv<{ authUser: AuthUser }>>(c: Context<E>) {
  const user = c.get("authUser");
  const submissionId = c.req.param("id");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  if (!submissionId) {
    throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
  }
  return { user, submissionId };
}

function invalidateImageCache<E extends AppEnv<{ authUser: AuthUser }>>(
  c: Context<E>,
  markerId: string,
): void {
  c.executionCtx.waitUntil(
    invalidateUploadCaches({
      kv: c.env.OEM_KV,
      kind: "image",
      markerId,
    }),
  );
}

function prewarmIfActive<E extends AppEnv<{ authUser: AuthUser }>>(
  c: Context<E>,
  status: string,
  filePath: string | null,
): void {
  if (status !== "active") {
    return;
  }
  const config = getRuntimeConfig(c.env);
  c.executionCtx.waitUntil(prewarmPublicUgcAsset(config.ugcAssetBaseUrl, filePath));
}

function invalidateCommentCache<E extends AppEnv<{ authUser: AuthUser }>>(
  c: Context<E>,
  markerId: string,
): void {
  c.executionCtx.waitUntil(
    invalidateUploadCaches({
      kv: c.env.OEM_KV,
      kind: "comment",
      markerId,
    }),
  );
}

function mergeViewerPendingComments(
  publicComments: PublicSubmissionComment[],
  viewerComments: UserSubmissionComment[],
): PublicSubmissionComment[] {
  const commentById = new Map<string, PublicSubmissionComment>();
  const indexTree = (comments: PublicSubmissionComment[]): void => {
    comments.forEach((comment) => {
      commentById.set(comment.id, comment);
      indexTree(comment.replies);
    });
  };
  indexTree(publicComments);

  const pendingRoots: PublicSubmissionComment[] = [];
  const pending = viewerComments
    .filter((comment) => comment.status === "pending_openai" || comment.status === "pending_audit")
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    );

  pending.forEach((comment) => {
    if (commentById.has(comment.id)) {
      return;
    }

    const normalized: PublicSubmissionComment = {
      ...comment,
      replyCount: comment.replyCount ?? 0,
      replies: comment.replies ?? [],
    };
    const parent = normalized.parentId ? commentById.get(normalized.parentId) : undefined;
    if (parent) {
      parent.replies.push(normalized);
      parent.replyCount += 1;
    } else {
      pendingRoots.push(normalized);
    }
    commentById.set(normalized.id, normalized);
  });

  return pendingRoots.length > 0 ? [...pendingRoots, ...publicComments] : publicComments;
}

export function createRoutes() {
  const app = new Hono<AppEnv<{ requestId: string }>>();

  app.post("/images", requireActiveUser, requireUploadsEnabled, rateLimit("upload"), async (c) => {
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
      content: pickString(form.content),
    });
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid upload payload.",
        parsed.error.flatten(),
      );
    }

    const config = getRuntimeConfig(c.env);
    const normalizedMime = normalizeUploadMime(file);
    if (
      !config.allowedUploadMime.has(normalizedMime) ||
      extensionFromMime(normalizedMime) === "bin"
    ) {
      throw new ApiError(422, "MIME_NOT_ALLOWED", "File MIME type is not allowed.");
    }

    const body = await file.arrayBuffer();
    if (body.byteLength <= 0 || body.byteLength > config.maxUploadBytes) {
      throw new ApiError(422, "UPLOAD_SIZE_INVALID", "Upload body size is invalid.", {
        maxBytes: config.maxUploadBytes,
      });
    }

    const preparedImage = await prepareUploadImageForStorage({
      body,
      mimeType: normalizedMime,
      transcoder: c.env.OEM_IMG_TRANS,
      signal: c.req.raw.signal,
      requestId: c.get("requestId"),
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
    const poiType = normalizePathPart(parsed.data.poiType);
    const poiHash = normalizePathPart(parsed.data.poiHash);
    const uploadPrefix = resolveUploadPrefix(c.req.raw, config.ugcUploadPathPrefix);
    const uploadScope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, undefined);
    const objectKey = buildUploadObjectKey({
      poiType,
      poiHash,
      snapshotId,
      mimeType: preparedImage.mimeType,
      prefix: uploadPrefix,
    });

    c.req.raw.signal.throwIfAborted();
    await c.env.UGC_BUCKET.put(objectKey, preparedImage.body, {
      httpMetadata: {
        contentType: preparedImage.mimeType,
        cacheControl: UGC_PUBLIC_IMAGE_CACHE_CONTROL,
      },
      customMetadata: {
        sourceMimeType: normalizedMime,
        convertedToWebp: preparedImage.converted ? "true" : "false",
      },
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
      status: "pending_openai",
    });
    await enqueueModeration(c.env, submissionId, snapshotId);
    const duplicatePoi = await getDuplicateImageMarkerSummary(c.env.DB, {
      markerId: parsed.data.markerId,
      pathPrefix: uploadScope.pathPrefix,
      excludePathPrefix: uploadScope.excludePathPrefix,
    });

    return c.json({
      ok: true,
      submission: {
        id: submissionId,
        markerId: parsed.data.markerId,
        status: "pending_openai",
        filePath: objectKey,
        snapshotId,
      },
      duplicatePoi: duplicatePoi
        ? {
            markerId: duplicatePoi.markerId,
            imageCount: duplicatePoi.imageCount,
            dashboardPath: `/ugc-review?duplicateMarker=${encodeURIComponent(duplicatePoi.markerId)}`,
          }
        : null,
    });
  });
  app.post(
    "/comments",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("upload"),
    async (c) => {
      const user = c.get("authUser");
      if (!user) {
        throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
      }

      const parsed = commentSubmissionSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid comment payload.",
          parsed.error.flatten(),
        );
      }

      const submissionId = nanoid(18);
      const snapshotId = nanoid(12);
      const poiType = normalizePathPart(parsed.data.poiType);
      const poiHash = normalizePathPart(parsed.data.poiHash);
      let parentId: string | null = null;
      let commentDepth = 0;

      if (parsed.data.parentId) {
        const parent = await getSubmissionById(c.env.DB, parsed.data.parentId);
        if (!parent || parent.kind !== "comment") {
          throw new ApiError(404, "PARENT_COMMENT_NOT_FOUND", "Parent comment was not found.");
        }
        if (
          parent.markerId !== parsed.data.markerId ||
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

      await createPendingSubmission(c.env.DB, {
        id: submissionId,
        markerId: parsed.data.markerId,
        poiHash,
        poiType,
        snapshotId,
        userId: user.uid,
        content: parsed.data.content,
        kind: "comment",
        status: "pending_openai",
        parentId,
        commentDepth,
      });
      await enqueueModeration(c.env, submissionId, snapshotId);

      return c.json({
        ok: true,
        submission: {
          id: submissionId,
          markerId: parsed.data.markerId,
          parentId,
          depth: commentDepth,
          status: "pending_openai",
          snapshotId,
        },
      });
    },
  );
  app.post("/comments/translations", rateLimit("public"), async (c) => {
    const parsed = commentTranslationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid translation payload.",
        parsed.error.flatten(),
      );
    }

    if (parsed.data.cachedOnly !== true) {
      await assertActiveUser(c);
    }

    return c.json(await translateVisibleComments(c.env, parsed.data));
  });

  app.get("/comments/mine", requireActiveUser, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const parsed = commentsQuerySchema.safeParse({
      markerId: c.req.query("markerId"),
      markerIds: c.req.query("markerIds"),
      scope: c.req.query("scope"),
      limit: c.req.query("limit"),
      replyLimit: c.req.query("replyLimit"),
      publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment query.", parsed.error.flatten());
    }

    const ids = requireMarkerIds(parsed.data);
    const items = await listUserCommentsByMarker(c.env.DB, {
      userId: user.uid,
      markerIds: ids,
      limit: parsed.data.limit ?? 50,
    });

    const response = c.json({ items });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });
  app.get("/comments", rateLimit("public"), async (c) => {
    const parsed = commentsQuerySchema.safeParse({
      markerId: c.req.query("markerId"),
      markerIds: c.req.query("markerIds"),
      scope: c.req.query("scope"),
      limit: c.req.query("limit"),
      replyLimit: c.req.query("replyLimit"),
      publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment query.", parsed.error.flatten());
    }

    const ids = requireMarkerIds(parsed.data);
    const limit = parsed.data.limit ?? 20;
    const replyLimit = parsed.data.replyLimit ?? 3;
    const cacheNamespace = resolvePublicCommentCacheNamespace(
      resolveImageScope(c.req.raw, getUgcReadConfig(c.env).ugcUploadPathPrefix, parsed.data.scope),
    );
    const publicResponsePromise = readPublicCommentsFromWorkersCache({
      markerIds: ids,
      limit,
      replyLimit,
      cacheNamespace,
    });

    if (parsed.data.publicOnly === "1" || !hasAuthHeaders(c.req.raw.headers)) {
      return publicReadResponse(await publicResponsePromise);
    }

    const [publicResponse, identity] = await Promise.all([
      publicResponsePromise,
      getOptionalAuthIdentity(c.env, c.req.raw.headers),
    ]);
    if (!identity || publicResponse instanceof Response) {
      return publicReadResponse(publicResponse);
    }

    const { payload } = publicResponse;
    const submissionIds: string[] = [];
    const collectIds = (comments: PublicSubmissionComment[]): void => {
      for (const comment of comments) {
        submissionIds.push(comment.id);
        collectIds(comment.replies);
      }
    };
    collectIds(payload.items);
    const viewerState = await listCommentViewerStateByMarker(c.env.DB, {
      userId: identity.uid,
      markerIds: ids,
      submissionIds,
      pendingLimit: 200,
    });
    const publicComments = applyCommentViewerReactions(payload.items, viewerState.reactions);
    const items = mergeViewerPendingComments(publicComments, viewerState.pendingComments);

    const response = c.json({ ...payload, items });
    for (const header of ["x-oem-partial-response", "x-oem-failed-marker-count"]) {
      const value = publicResponse.headers[header];
      if (value !== undefined) {
        response.headers.set(header, value);
      }
    }
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("x-oem-viewer-overlay", "comment");
    return response;
  });
  // Keep after /comments/mine so "mine" is not treated as a comment ID.
  app.get("/comments/:id", rateLimit("public"), async (c) => {
    const parsed = commentQuerySchema.safeParse({
      markerId: c.req.query("markerId"),
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment query.", parsed.error.flatten());
    }

    const identity = await getOptionalAuthIdentity(c.env, c.req.raw.headers);
    const item = await getPublicCommentContextById(c.env.DB, {
      id: c.req.param("id"),
      markerId: parsed.data.markerId,
      ...(identity ? { viewerUserId: identity.uid } : {}),
    });
    if (!item) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", "Comment not found.");
    }

    const response = c.json({ item });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });
  for (const [path, value] of [
    ["/comments/:id/upvote", 1],
    ["/comments/:id/downvote", -1],
  ] as const) {
    app.post(path, requireActiveUser, requireUploadsEnabled, rateLimit("auth"), async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "comment") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
      }
      if (!["active", "flagged", "remove_request"].includes(submission.status)) {
        throw new ApiError(
          409,
          "INVALID_SUBMISSION_STATUS",
          "Only visible comments can be voted.",
          {
            status: submission.status,
          },
        );
      }

      const vote = await setSubmissionVote(c.env.DB, {
        submissionId,
        actor: user,
        value,
      });
      const score = await getSubmissionScore(c.env.DB, submissionId);
      invalidateCommentCache(c, submission.markerId);
      if (vote.notifications.length > 0) {
        c.executionCtx.waitUntil(publishNotificationsCreated(c.env, vote.notifications));
      }

      return c.json({ ok: true, vote: vote.currentVote, previousVote: vote.previousVote, score });
    });
  }
  app.post(
    "/comments/:id/flag",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "comment") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
      }
      if (submission.userId === user.uid) {
        throw new ApiError(403, "CANNOT_FLAG_OWN_SUBMISSION", "You cannot flag your own comment.");
      }
      if (submission.status !== "active" && submission.status !== "flagged") {
        throw new ApiError(
          409,
          "INVALID_SUBMISSION_STATUS",
          "Only active or flagged comments can be flagged.",
          {
            status: submission.status,
          },
        );
      }

      const created = await createSubmissionFlag(c.env.DB, {
        submissionId,
        userId: user.uid,
      });
      if (created && submission.status === "active") {
        await updateSubmissionStatus(c.env.DB, {
          id: submissionId,
          status: "flagged",
          moderationNote: "Flagged by user.",
        });
      }
      const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
      invalidateCommentCache(c, submission.markerId);
      if (created) {
        c.executionCtx.waitUntil(
          notifyFlagCreated(c.env, {
            submission,
            actor: user,
            changed: created,
            flagCount,
            nextStatus: "flagged",
          }),
        );
      }

      return c.json({ ok: true, created, status: "flagged", flagCount });
    },
  );
  app.post(
    "/comments/:id/unflag",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "comment") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
      }
      if (submission.userId === user.uid) {
        throw new ApiError(
          403,
          "CANNOT_UNFLAG_OWN_SUBMISSION",
          "You cannot unflag your own comment.",
        );
      }
      if (submission.status !== "active" && submission.status !== "flagged") {
        throw new ApiError(
          409,
          "INVALID_SUBMISSION_STATUS",
          "Only active or flagged comments can be unflagged.",
          {
            status: submission.status,
          },
        );
      }

      const deleted = await deleteSubmissionFlag(c.env.DB, {
        submissionId,
        userId: user.uid,
      });
      const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
      const status = flagCount > 0 ? "flagged" : "active";
      if (submission.status !== status) {
        await updateSubmissionStatus(c.env.DB, {
          id: submissionId,
          status,
          moderationNote: status === "active" ? "User flag removed." : undefined,
        });
      }
      invalidateCommentCache(c, submission.markerId);
      if (deleted) {
        c.executionCtx.waitUntil(
          notifyFlagRemoved(c.env, {
            submission,
            actor: user,
            changed: deleted,
            flagCount,
            nextStatus: status,
          }),
        );
      }

      return c.json({ ok: true, deleted, status, flagCount });
    },
  );
  app.post(
    "/comments/:id/edit",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("upload"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const parsed = commentEditSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid comment edit payload.",
          parsed.error.flatten(),
        );
      }

      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "comment") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
      }
      const isAuthor = submission.userId === user.uid;
      const isAdmin = user.role === "a" || user.role === "r";
      if (!isAuthor && !isAdmin) {
        throw new ApiError(
          403,
          "COMMENT_EDIT_OWNER_ONLY",
          "Only the author or an admin can edit a comment.",
        );
      }
      if (
        !["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(
          submission.status,
        )
      ) {
        throw new ApiError(
          409,
          "INVALID_SUBMISSION_STATUS",
          "Comment cannot be edited in its current status.",
          {
            status: submission.status,
          },
        );
      }

      if (submission.content === parsed.data.content) {
        return c.json({
          ok: true,
          submission: {
            id: submission.id,
            markerId: submission.markerId,
            parentId: submission.parentId,
            depth: submission.commentDepth,
            status: submission.status,
            snapshotId: submission.snapshotId,
          },
        });
      }

      const snapshotId = nanoid(12);
      const updated = await updateCommentContentForModeration(c.env.DB, {
        id: submissionId,
        content: parsed.data.content,
        expectedSnapshotId: submission.snapshotId,
        snapshotId,
        moderationNote: `${
          isAuthor ? COMMENT_EDIT_MODERATION_NOTE_PREFIX : COMMENT_ADMIN_EDIT_MODERATION_NOTE_PREFIX
        } awaiting moderation.`,
      });
      if (!updated) {
        throw new ApiError(
          409,
          "COMMENT_EDIT_CONFLICT",
          "Comment changed while the edit was being submitted.",
        );
      }
      await clearSubmissionFlags(c.env.DB, submissionId);
      invalidateCommentCache(c, submission.markerId);
      await enqueueModeration(c.env, submissionId, snapshotId);

      return c.json({
        ok: true,
        submission: {
          id: submission.id,
          markerId: submission.markerId,
          parentId: submission.parentId,
          depth: submission.commentDepth,
          status: "pending_openai",
          snapshotId,
        },
      });
    },
  );
  app.post(
    "/comments/:id/remove-request",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "comment") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
      }
      if (submission.userId !== user.uid) {
        throw new ApiError(
          403,
          "REMOVE_REQUEST_OWNER_ONLY",
          "Only the author can request comment removal.",
        );
      }
      if (submission.status !== "active" && submission.status !== "flagged") {
        throw new ApiError(
          409,
          "INVALID_STATUS_TRANSITION",
          "Only visible comments can receive a remove request.",
          {
            from: submission.status,
            to: "remove_request",
          },
        );
      }

      await updateSubmissionStatus(c.env.DB, {
        id: submissionId,
        status: "remove_request",
        moderationNote: "Removal requested by author.",
      });
      invalidateCommentCache(c, submission.markerId);
      c.executionCtx.waitUntil(
        notifyRemoveRequestCreated(c.env, {
          submission,
          actor: user,
          nextStatus: "remove_request",
          source: "remove_request",
        }),
      );

      return c.json({ ok: true, status: "remove_request" });
    },
  );
  app.post(
    "/comments/:id/recall",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "comment") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
      }
      if (submission.userId !== user.uid) {
        throw new ApiError(403, "RECALL_OWNER_ONLY", "Only the author can recall a comment.");
      }
      if (submission.editOriginalContent !== null) {
        const originalStatus = submission.editOriginalStatus;
        const status =
          originalStatus === "pending_openai" || originalStatus === "pending_audit"
            ? originalStatus
            : "active";
        const reverted = await revertCommentEdit(c.env.DB, {
          id: submissionId,
          expectedSnapshotId: submission.snapshotId,
          status,
          moderationNote: "Comment edit reverted by author.",
        });
        if (!reverted) {
          throw new ApiError(
            409,
            "COMMENT_EDIT_CONFLICT",
            "Comment changed while the edit was being reverted.",
          );
        }
        invalidateCommentCache(c, submission.markerId);
        if (status === "pending_openai" && submission.editOriginalSnapshotId) {
          await enqueueModeration(c.env, submissionId, submission.editOriginalSnapshotId);
        }
        return c.json({
          ok: true,
          status,
          editReverted: true,
          content: submission.editOriginalContent,
        });
      }
      if (submission.status === "stale") {
        return c.json({ ok: true, status: "stale" });
      }
      if (
        !["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(
          submission.status,
        )
      ) {
        throw new ApiError(
          409,
          "INVALID_STATUS_TRANSITION",
          "Comment cannot be recalled from its current status.",
          {
            from: submission.status,
            to: "stale",
          },
        );
      }

      const transition = await transitionSubmissionStatusWithNotifications(c.env.DB, {
        submission,
        status: "stale",
        moderationNote: `${RECALL_MODERATION_NOTE_PREFIX} comment withdrawn by author.`,
        source: "user_action",
      });
      if (!transition.updated) {
        throw new ApiError(409, "RECALL_CONFLICT", "Comment changed while it was being recalled.");
      }
      if (transition.notifications.length > 0) {
        c.executionCtx.waitUntil(publishNotificationsCreated(c.env, transition.notifications));
      }
      invalidateCommentCache(c, submission.markerId);
      return c.json({ ok: true, status: "stale" });
    },
  );

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
    headers.set("Cache-Control", UGC_PUBLIC_IMAGE_CACHE_CONTROL);
    headers.set(
      "Content-Type",
      object.httpMetadata?.contentType ?? submission.mimeType ?? "application/octet-stream",
    );

    return new Response(object.body, {
      status: 200,
      headers,
    });
  });
  app.get("/images/mine", requireActiveUser, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const parsed = imagesQuerySchema.safeParse({
      markerId: c.req.query("markerId"),
      markerIds: c.req.query("markerIds"),
      scope: c.req.query("scope"),
      limit: c.req.query("limit"),
      publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
    }

    const ids = requireMarkerIds(parsed.data, false);
    const config = getUgcReadConfig(c.env);
    const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
    const items = await listUserImagesByMarker(c.env.DB, {
      userId: user.uid,
      markerIds: ids,
      assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
      privateAssetBaseUrl: resolvePrivateAssetBaseUrl(c.req.url),
      pathPrefix: scope.pathPrefix,
      excludePathPrefix: scope.excludePathPrefix,
      limit: parsed.data.limit ?? 6,
    });

    const response = c.json({ items });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });
  // Keep after /images/mine so "mine" is not treated as an image ID.
  app.get("/images/:id", rateLimit("public"), async (c) => {
    const parsed = imageQuerySchema.safeParse({
      markerId: c.req.query("markerId"),
      scope: c.req.query("scope"),
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
    }

    const config = getRuntimeConfig(c.env);
    const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
    const identity = await getOptionalAuthIdentity(c.env, c.req.raw.headers);
    const item = await getPublicImageById(c.env.DB, {
      id: c.req.param("id"),
      markerId: parsed.data.markerId,
      assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
      ...scope,
      viewerUserId: identity?.uid,
    });
    if (!item) {
      throw new ApiError(404, "NOT_FOUND", "Image not found.");
    }
    const response = c.json({ item });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });
  app.get("/file/*", requireActiveUser, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    const objectKey = parseObjectKeyFromRequestPath(c.req.path);
    const submission = await getImageSubmissionByFilePath(c.env.DB, objectKey, user);
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
    headers.set("Cache-Control", "private, max-age=60");
    headers.set(
      "Content-Type",
      object.httpMetadata?.contentType ?? submission.mimeType ?? "application/octet-stream",
    );

    return new Response(object.body, {
      status: 200,
      headers,
    });
  });
  app.post(
    "/images/:id/upvote",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "image") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
      }
      if (!["active", "flagged", "remove_request"].includes(submission.status)) {
        throw new ApiError(
          409,
          "INVALID_SUBMISSION_STATUS",
          "Only visible images can be upvoted.",
          {
            status: submission.status,
          },
        );
      }

      const created = await createSubmissionUpvote(c.env.DB, {
        submissionId,
        actor: user,
      });
      const upvoteCount = await countSubmissionUpvotes(c.env.DB, submissionId);
      invalidateImageCache(c, submission.markerId);
      if (created.notifications.length > 0) {
        c.executionCtx.waitUntil(publishNotificationsCreated(c.env, created.notifications));
      }

      return c.json({ ok: true, created: created.created, upvoteCount });
    },
  );
  app.post(
    "/images/:id/unvote",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "image") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
      }
      if (!["active", "flagged", "remove_request"].includes(submission.status)) {
        throw new ApiError(
          409,
          "INVALID_SUBMISSION_STATUS",
          "Only visible images can be unvoted.",
          {
            status: submission.status,
          },
        );
      }

      const deleted = await deleteSubmissionUpvote(c.env.DB, {
        submissionId,
        userId: user.uid,
      });
      const upvoteCount = await countSubmissionUpvotes(c.env.DB, submissionId);
      invalidateImageCache(c, submission.markerId);

      return c.json({ ok: true, deleted, upvoteCount });
    },
  );
  app.post(
    "/images/:id/flag",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "image") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
      }
      if (submission.userId === user.uid) {
        throw new ApiError(403, "CANNOT_FLAG_OWN_SUBMISSION", "You cannot flag your own image.");
      }
      if (submission.status !== "active" && submission.status !== "flagged") {
        throw new ApiError(
          409,
          "INVALID_SUBMISSION_STATUS",
          "Only active or flagged images can be flagged.",
          {
            status: submission.status,
          },
        );
      }

      const created = await createSubmissionFlag(c.env.DB, {
        submissionId,
        userId: user.uid,
      });
      if (created && submission.status === "active") {
        await updateSubmissionStatus(c.env.DB, {
          id: submissionId,
          status: "flagged",
          moderationNote: "Flagged by user.",
        });
      }
      const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
      invalidateImageCache(c, submission.markerId);
      if (created) {
        c.executionCtx.waitUntil(
          notifyFlagCreated(c.env, {
            submission,
            actor: user,
            changed: created,
            flagCount,
            nextStatus: "flagged",
          }),
        );
      }

      return c.json({ ok: true, created, status: "flagged", flagCount });
    },
  );
  app.post(
    "/images/:id/unflag",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "image") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
      }
      if (submission.userId === user.uid) {
        throw new ApiError(
          403,
          "CANNOT_UNFLAG_OWN_SUBMISSION",
          "You cannot unflag your own image.",
        );
      }
      if (submission.status !== "active" && submission.status !== "flagged") {
        throw new ApiError(
          409,
          "INVALID_SUBMISSION_STATUS",
          "Only active or flagged images can be unflagged.",
          {
            status: submission.status,
          },
        );
      }

      const deleted = await deleteSubmissionFlag(c.env.DB, {
        submissionId,
        userId: user.uid,
      });
      const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
      const status = flagCount > 0 ? "flagged" : "active";
      if (submission.status !== status) {
        await updateSubmissionStatus(c.env.DB, {
          id: submissionId,
          status,
          moderationNote: status === "active" ? "User flag removed." : undefined,
        });
        prewarmIfActive(c, status, submission.filePath);
      }
      invalidateImageCache(c, submission.markerId);
      if (deleted) {
        c.executionCtx.waitUntil(
          notifyFlagRemoved(c.env, {
            submission,
            actor: user,
            changed: deleted,
            flagCount,
            nextStatus: status,
          }),
        );
      }

      return c.json({ ok: true, deleted, status, flagCount });
    },
  );
  app.post(
    "/images/:id/remove-request",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission) {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission was not found.");
      }
      if (submission.userId !== user.uid) {
        throw new ApiError(
          403,
          "REMOVE_REQUEST_OWNER_ONLY",
          "Only the uploader can request image removal.",
        );
      }
      if (submission.status !== "active" && submission.status !== "flagged") {
        throw new ApiError(
          409,
          "INVALID_STATUS_TRANSITION",
          "Only visible images can receive a remove request.",
          {
            from: submission.status,
            to: "remove_request",
          },
        );
      }

      await updateSubmissionStatus(c.env.DB, {
        id: submissionId,
        status: "remove_request",
        moderationNote: "Removal requested by uploader.",
      });
      invalidateImageCache(c, submission.markerId);
      c.executionCtx.waitUntil(
        notifyRemoveRequestCreated(c.env, {
          submission,
          actor: user,
          nextStatus: "remove_request",
          source: "remove_request",
        }),
      );

      return c.json({ ok: true, status: "remove_request" });
    },
  );
  app.post(
    "/images/:id/unrecall",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
      const submission = await getSubmissionById(c.env.DB, submissionId);
      if (!submission || submission.kind !== "image") {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
      }
      if (submission.userId !== user.uid) {
        throw new ApiError(403, "RECALL_OWNER_ONLY", "Only the uploader can cancel image recall.");
      }
      if (submission.status !== "remove_request") {
        throw new ApiError(
          409,
          "INVALID_STATUS_TRANSITION",
          "Only remove requests can be cancelled.",
          {
            from: submission.status,
            to: "active",
          },
        );
      }

      const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
      const status = flagCount > 0 ? "flagged" : "active";
      await updateSubmissionStatus(c.env.DB, {
        id: submissionId,
        status,
        moderationNote: "Removal request cancelled by uploader.",
      });
      prewarmIfActive(c, status, submission.filePath);
      invalidateImageCache(c, submission.markerId);
      c.executionCtx.waitUntil(
        notifyRemoveRequestCancelled(c.env, {
          submission,
          actor: user,
          nextStatus: status,
          flagCount,
        }),
      );

      return c.json({ ok: true, status, flagCount });
    },
  );
  app.post(
    "/images/:id/recall",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    async (c) => {
      const { user, submissionId } = requireUserAndSubmissionId(c);
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
      if (
        !["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(
          submission.status,
        )
      ) {
        throw new ApiError(
          409,
          "INVALID_STATUS_TRANSITION",
          "Image cannot be recalled from its current status.",
          {
            from: submission.status,
            to: "stale",
          },
        );
      }

      const transition = await transitionSubmissionStatusWithNotifications(c.env.DB, {
        submission,
        status: "stale",
        moderationNote: `${RECALL_MODERATION_NOTE_PREFIX} image withdrawn by uploader.`,
        source: "user_action",
      });
      if (!transition.updated) {
        throw new ApiError(409, "RECALL_CONFLICT", "Image changed while it was being recalled.");
      }
      if (transition.notifications.length > 0) {
        c.executionCtx.waitUntil(publishNotificationsCreated(c.env, transition.notifications));
      }
      invalidateImageCache(c, submission.markerId);
      return c.json({ ok: true, status: "stale" });
    },
  );
  const publicImageLimit = rateLimit("public");
  const privateImageLimit = rateLimit("auth");
  app.get(
    "/images",
    createMiddleware<AppEnv<{ authUser?: AuthUser; authUserPromise?: Promise<AuthUser> }>>(
      async (c, next) => {
        const includeMine = c.req.query("includeMine");
        if (includeMine !== undefined && includeMine !== "1") {
          throw new ApiError(422, "VALIDATION_ERROR", "includeMine must be 1 when supplied.");
        }
        if (includeMine === "1") {
          if (c.req.query("publicOnly") === "1") {
            throw new ApiError(
              422,
              "VALIDATION_ERROR",
              "includeMine and publicOnly cannot be combined.",
            );
          }
          await assertActiveUser(c);
          return privateImageLimit(c, next);
        }
        return publicImageLimit(c, next);
      },
    ),
    async (c) => {
      if (c.req.query("includeMine") === "1") {
        // Both sections share authentication, but keep independent failure semantics.
        // Only the public section's source data crosses the public-cache boundary.

        const user = c.get("authUser");
        if (!user) {
          throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
        }
        const parsed = imagesQuerySchema.safeParse(c.req.query());
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.");
        }
        const markerIds = requireMarkerIds(parsed.data);
        const config = getUgcReadConfig(c.env);
        const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
        const assetBaseUrl = resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl);
        const limit = parsed.data.limit ?? 6;

        const [images, mine] = await Promise.allSettled([
          (async () => {
            const result = await readPublicImagesFromWorkersCache({
              markerIds,
              limit,
              assetBaseUrl,
              cacheNamespace: resolvePublicImageCacheNamespace(scope),
            });
            if (result instanceof Response) {
              throw new ApiError(
                503,
                "PUBLIC_CACHE_READ_FAILED",
                "Public images could not be read.",
              );
            }
            const reactions = await listImageViewerReactionsByMarker(c.env.DB, {
              userId: user.uid,
              markerIds,
              submissionIds: result.payload.items.map((item) => item.id),
              ...scope,
            });
            return {
              ...result.payload,
              items: applyImageViewerReactions(result.payload.items, reactions),
            };
          })(),
          listUserImagesByMarker(c.env.DB, {
            userId: user.uid,
            markerIds,
            assetBaseUrl,
            privateAssetBaseUrl: resolvePrivateAssetBaseUrl(c.req.url),
            limit,
            ...scope,
          }).then((items) => ({ items })),
        ]);

        function section<T>(name: string, result: PromiseSettledResult<T>) {
          if (result.status === "fulfilled") {
            return result.value;
          }
          const error = toApiError(result.reason);
          console.error("[point-images] section failed", {
            section: name,
            code: error.code,
            requestId: c.get("requestId"),
          });
          return { error: { code: error.code, status: error.status, message: error.message } };
        }
        const partial =
          images.status === "rejected" ||
          mine.status === "rejected" ||
          (images.status === "fulfilled" && images.value.partial === true);
        c.header("Cache-Control", "private, no-store");
        if (partial) {
          c.header("x-oem-partial-response", "true");
        }
        return c.json(
          { images: section("images", images), mine: section("mine", mine) },
          partial ? 207 : 200,
        );
      }

      const parsed = imagesQuerySchema.safeParse({
        markerId: c.req.query("markerId"),
        markerIds: c.req.query("markerIds"),
        scope: c.req.query("scope"),
        limit: c.req.query("limit"),
        publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
      });
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
      }

      const ids = requireMarkerIds(parsed.data);
      const config = getUgcReadConfig(c.env);
      const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
      const limit = parsed.data.limit ?? 6;
      const assetBaseUrl = resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl);
      const publicResponsePromise = readPublicImagesFromWorkersCache({
        markerIds: ids,
        limit,
        cacheNamespace: resolvePublicImageCacheNamespace(scope),
        assetBaseUrl,
      });

      if (parsed.data.publicOnly === "1" || !hasAuthHeaders(c.req.raw.headers)) {
        return publicReadResponse(await publicResponsePromise);
      }

      const [publicResponse, identity] = await Promise.all([
        publicResponsePromise,
        getOptionalAuthIdentity(c.env, c.req.raw.headers),
      ]);
      if (!identity || publicResponse instanceof Response) {
        return publicReadResponse(publicResponse);
      }

      const { payload } = publicResponse;
      const reactions = await listImageViewerReactionsByMarker(c.env.DB, {
        userId: identity.uid,
        markerIds: ids,
        submissionIds: payload.items.map((image) => image.id),
        pathPrefix: scope.pathPrefix,
        excludePathPrefix: scope.excludePathPrefix,
      });
      const images = applyImageViewerReactions(payload.items, reactions);

      const response = c.json({ ...payload, items: images });
      for (const header of ["x-oem-partial-response", "x-oem-failed-marker-count"]) {
        const value = publicResponse.headers[header];
        if (value !== undefined) {
          response.headers.set(header, value);
        }
      }
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("x-oem-viewer-overlay", "image");
      return response;
    },
  );

  return app;
}
