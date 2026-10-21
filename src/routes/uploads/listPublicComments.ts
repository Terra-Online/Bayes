import type { Context } from "hono";

import { getUgcReadConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { readPublicCommentsFromWorkersCache, publicReadResponse } from "@/publicRead/client/client";
import { resolvePublicCommentCacheNamespace } from "@/publicRead/client/scope";
import {
  listCommentViewerStateByMarker,
  listUserCommentsByMarker,
} from "@/repositories/submission/listComments";
import type {
  PublicSubmissionComment,
  UserSubmissionComment,
} from "@/repositories/submission/types";
import { commentsQuerySchema } from "@/routes/schema/uploads";
import { applyCommentViewerReactions } from "@/services/upload/viewerOverlay";
import type { AppEnv, AuthUser } from "@/types/app";

import { getOptionalAuthIdentity, hasAuthHeaders, requireMarkerIds } from "./helpers";
import { resolveImageScope } from "./scope";

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

export async function handleListMyComments<E extends AppEnv<{ authUser: AuthUser }>>(
  c: Context<E>,
) {
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
}

export async function handleListPublicComments<E extends AppEnv>(c: Context<E>) {
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
}
