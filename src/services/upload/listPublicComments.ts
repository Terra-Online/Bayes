import { getRuntimeConfig } from "../../lib/config";
import { ApiError } from "../../lib/errors";
import { InFlightBatchLoader } from "../../middleware/cache/inFlightBatchLoader";
import {
  PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
  PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT,
  readPublicMarkerCommentCache,
  resolvePublicCommentCacheNamespace,
  writePublicMarkerCommentCache
} from "../../middleware/cache/publicMarkerComments";
import { fetchPublicCommentsFromWorkersCache } from "../../middleware/cache/publicReadClient";
import {
  listActiveCommentsByMarker,
  listCommentViewerStateByMarker,
  listUserCommentsByMarker
} from "../../repositories/submission/listComments";
import type {
  PublicSubmissionComment,
  UserSubmissionComment
} from "../../repositories/submission/types";
import type { AppEnv } from "../../types/app";
import { getOptionalAuthIdentity, hasAuthHeaders, requireMarkerIds } from "./helpers";
import { commentsQuerySchema } from "./schemas";
import { resolveImageScope } from "./scope";
import { applyCommentViewerReactions } from "./viewerOverlay";

const commentLoadersByDb = new WeakMap<
  D1Database,
  Map<string, InFlightBatchLoader<PublicSubmissionComment[]>>
>();

function getPublicCommentLoader(payload: {
  db: D1Database;
  cacheNamespace: ReturnType<typeof resolvePublicCommentCacheNamespace>;
}): InFlightBatchLoader<PublicSubmissionComment[]> {
  let loaders = commentLoadersByDb.get(payload.db);
  if (!loaders) {
    loaders = new Map();
    commentLoadersByDb.set(payload.db, loaders);
  }

  let loader = loaders.get(payload.cacheNamespace);
  if (!loader) {
    loader = new InFlightBatchLoader<PublicSubmissionComment[]>();
    loaders.set(payload.cacheNamespace, loader);
  }
  return loader;
}

function groupPublicCommentsByMarker(
  markerIds: string[],
  comments: PublicSubmissionComment[]
): Map<string, PublicSubmissionComment[]> {
  const grouped = new Map<string, PublicSubmissionComment[]>();
  markerIds.forEach((markerId) => grouped.set(markerId, []));
  comments.forEach((comment) => {
    const bucket = grouped.get(comment.markerId);
    if (bucket) {
      bucket.push(comment);
    }
  });
  return grouped;
}

function sliceCommentTree(
  comment: PublicSubmissionComment,
  replyLimit: number
): PublicSubmissionComment {
  return {
    ...comment,
    replies: comment.replies.slice(0, replyLimit)
  };
}

function flattenPublicCommentsByMarker(
  markerIds: string[],
  grouped: Map<string, PublicSubmissionComment[]>,
  limit: number,
  replyLimit: number
): PublicSubmissionComment[] {
  return markerIds.flatMap((markerId) => (grouped.get(markerId) ?? [])
    .slice(0, limit)
    .map((comment) => sliceCommentTree(comment, replyLimit)));
}

function mergeViewerPendingComments(
  publicComments: PublicSubmissionComment[],
  viewerComments: UserSubmissionComment[]
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
    .sort((left, right) => (
      left.depth - right.depth ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id)
    ));

  pending.forEach((comment) => {
    if (commentById.has(comment.id)) return;

    const normalized: PublicSubmissionComment = {
      ...comment,
      replyCount: comment.replyCount ?? 0,
      replies: comment.replies ?? []
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

export async function listCachedPublicCommentsByMarker(
  payload: {
    db: D1Database;
    kv?: KVNamespace;
    markerIds: string[];
    limit: number;
    replyLimit: number;
    cacheNamespace: ReturnType<typeof resolvePublicCommentCacheNamespace>;
    waitUntil: (promise: Promise<unknown>) => void;
  }
): Promise<PublicSubmissionComment[]> {
  const grouped = new Map<string, PublicSubmissionComment[]>();
  const missingIds: string[] = [];

  if (payload.kv) {
    const cacheResults = await Promise.all(
      payload.markerIds.map(async (markerId) => ({
        markerId,
        comments: await readPublicMarkerCommentCache(payload.kv, payload.cacheNamespace, markerId)
      }))
    );

    cacheResults.forEach(({ markerId, comments }) => {
      if (comments) {
        grouped.set(markerId, comments);
      } else {
        missingIds.push(markerId);
      }
    });
  } else {
    missingIds.push(...payload.markerIds);
  }

  if (missingIds.length > 0) {
    const loader = getPublicCommentLoader(payload);
    const loaded = await Promise.all(missingIds.map(async (markerId) => ({
      markerId,
      comments: await loader.load(markerId, async (markerIds) => {
        const dbComments = await listActiveCommentsByMarker(payload.db, {
          markerIds,
          limit: PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
          replyLimit: PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT
        });
        const dbGrouped = groupPublicCommentsByMarker(markerIds, dbComments);
        if (payload.kv) {
          payload.waitUntil(Promise.all(markerIds.map((missingMarkerId) => (
            writePublicMarkerCommentCache(
              payload.kv,
              payload.cacheNamespace,
              missingMarkerId,
              dbGrouped.get(missingMarkerId) ?? []
            )
          ))).catch(() => undefined));
        }
        return dbGrouped;
      })
    })));

    loaded.forEach(({ markerId, comments }) => {
      grouped.set(markerId, comments);
    });
  }

  return flattenPublicCommentsByMarker(payload.markerIds, grouped, payload.limit, payload.replyLimit);
}

export async function handleListMyComments(c: import("hono").Context<AppEnv>) {
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
    publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment query.", parsed.error.flatten());
  }

  const ids = requireMarkerIds(parsed.data);
  const items = await listUserCommentsByMarker(c.env.DB, {
    userId: user.uid,
    markerIds: ids,
    limit: parsed.data.limit ?? 50
  });

  const response = c.json({ items });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function handleListPublicComments(c: import("hono").Context<AppEnv>) {
  const parsed = commentsQuerySchema.safeParse({
    markerId: c.req.query("markerId"),
    markerIds: c.req.query("markerIds"),
    scope: c.req.query("scope"),
    limit: c.req.query("limit"),
    replyLimit: c.req.query("replyLimit"),
    publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment query.", parsed.error.flatten());
  }

  const ids = requireMarkerIds(parsed.data);
  const limit = parsed.data.limit ?? 20;
  const replyLimit = parsed.data.replyLimit ?? 3;
  const cacheNamespace = resolvePublicCommentCacheNamespace(resolveImageScope(
    c.req.raw,
    getRuntimeConfig(c.env).ugcUploadPathPrefix,
    parsed.data.scope
  ));
  const publicResponsePromise = fetchPublicCommentsFromWorkersCache({
    markerIds: ids,
    limit,
    replyLimit,
    cacheNamespace
  });

  if (parsed.data.publicOnly === "1" || !hasAuthHeaders(c.req.raw.headers)) {
    return publicResponsePromise;
  }

  const [publicResponse, identity] = await Promise.all([
    publicResponsePromise,
    getOptionalAuthIdentity(c.env, c.req.raw.headers)
  ]);
  if (!identity || !publicResponse.ok) return publicResponse;

  const payload = await publicResponse.json() as { items: PublicSubmissionComment[]; partial?: boolean };
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
    pendingLimit: 200
  });
  const publicComments = applyCommentViewerReactions(payload.items, viewerState.reactions);
  const items = mergeViewerPendingComments(publicComments, viewerState.pendingComments);

  const response = c.json({ ...payload, items });
  for (const header of ["x-oem-partial-response", "x-oem-failed-marker-count"]) {
    const value = publicResponse.headers.get(header);
    if (value !== null) response.headers.set(header, value);
  }
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("x-oem-viewer-overlay", "comment");
  return response;
}
