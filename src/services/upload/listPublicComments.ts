import { createAuth } from "../../lib/auth/createAuth";
import { getRuntimeConfig } from "../../lib/config";
import { ApiError } from "../../lib/errors";
import {
  PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
  PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT,
  readPublicMarkerCommentCache,
  resolvePublicCommentCacheNamespace,
  writePublicMarkerCommentCache
} from "../../middleware/cache/publicMarkerComments";
import { listActiveCommentsByMarker, listUserCommentsByMarker } from "../../repositories/submission/listComments";
import type { PublicSubmissionComment } from "../../repositories/submission/types";
import type { AppEnv } from "../../types/app";
import { requireMarkerIds } from "./helpers";
import { commentsQuerySchema } from "./schemas";
import { resolveImageScope } from "./scope";

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
    const dbComments = await listActiveCommentsByMarker(payload.db, {
      markerIds: missingIds,
      limit: PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
      replyLimit: PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT
    });
    const dbGrouped = groupPublicCommentsByMarker(missingIds, dbComments);

    missingIds.forEach((markerId) => {
      const comments = dbGrouped.get(markerId) ?? [];
      grouped.set(markerId, comments);
      if (payload.kv) {
        payload.waitUntil(writePublicMarkerCommentCache(
          payload.kv,
          payload.cacheNamespace,
          markerId,
          comments
        ));
      }
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
  const session = parsed.data.publicOnly === "1"
    ? null
    : await createAuth(c.env).api.getSession({
      headers: c.req.raw.headers
    });
  const useSharedCache = parsed.data.publicOnly === "1" || !session;

  const items = useSharedCache
    ? await listCachedPublicCommentsByMarker({
      db: c.env.DB,
      kv: c.env.OEM_KV,
      markerIds: ids,
      limit,
      replyLimit,
      cacheNamespace: resolvePublicCommentCacheNamespace(resolveImageScope(
        c.req.raw,
        getRuntimeConfig(c.env).ugcUploadPathPrefix,
        parsed.data.scope
      )),
      waitUntil: (promise) => c.executionCtx.waitUntil(promise)
    })
    : await listActiveCommentsByMarker(c.env.DB, {
      markerIds: ids,
      limit,
      replyLimit,
      viewerUserId: session?.user.id
    });

  const response = c.json({ items });
  if (useSharedCache) {
    response.headers.set("Cache-Control", items.length > 0 ? "public, max-age=15" : "public, max-age=5");
    response.headers.set("x-oem-marker-comment-kv-cache", "enabled");
  } else {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
