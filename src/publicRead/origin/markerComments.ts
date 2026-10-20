import { sha256Hex } from "../../lib/crypto";
import { listActiveCommentsByMarker } from "../../repositories/submission/listComments";
import { PUBLIC_MARKER_COMMENT_CACHE_LIMIT, PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT, type PublicCommentCacheNamespace } from "../contract/markers";
import type { PublicSubmissionComment } from "../../repositories/submission/types";
import {
  DEFAULT_KV_READ_CACHE_TTL_SECONDS,
  getJsonFromKv,
  putJsonToKv
} from "../../lib/kvJson";

export const PUBLIC_MARKER_COMMENT_POSITIVE_TTL_SECONDS = 90 * 24 * 60 * 60;
export const PUBLIC_MARKER_COMMENT_EMPTY_TTL_SECONDS = 10 * 60;

const PUBLIC_COMMENT_CACHE_NAMESPACES = ["default", "test", "prod"] as const;

type PublicMarkerCommentCacheEntry = {
  items: PublicSubmissionComment[];
};

async function getPublicMarkerCommentCacheKey(
  namespace: PublicCommentCacheNamespace,
  markerId: string
): Promise<string> {
  const version = "v2";
  return `ugc:marker-comments:${version}:${namespace}:${await sha256Hex(markerId)}`;
}

async function readPublicMarkerCommentCache(
  kv: KVNamespace | undefined,
  namespace: PublicCommentCacheNamespace,
  markerId: string
): Promise<PublicSubmissionComment[] | null> {
  if (!kv) return null;

  const entry = await getJsonFromKv<PublicMarkerCommentCacheEntry>(
    kv,
    await getPublicMarkerCommentCacheKey(namespace, markerId),
    { cacheTtl: DEFAULT_KV_READ_CACHE_TTL_SECONDS }
  );
  if (!entry || !Array.isArray(entry.items)) {
    return null;
  }

  return entry.items;
}

async function writePublicMarkerCommentCache(
  kv: KVNamespace | undefined,
  namespace: PublicCommentCacheNamespace,
  markerId: string,
  items: PublicSubmissionComment[]
): Promise<void> {
  if (!kv) return;

  const expirationTtl = items.length > 0
    ? PUBLIC_MARKER_COMMENT_POSITIVE_TTL_SECONDS
    : PUBLIC_MARKER_COMMENT_EMPTY_TTL_SECONDS;

  await putJsonToKv(
    kv,
    await getPublicMarkerCommentCacheKey(namespace, markerId),
    { items },
    { expirationTtl }
  );
}

export async function deletePublicMarkerCommentCache(
  kv: KVNamespace | undefined,
  markerId: string
): Promise<void> {
  if (!kv) return;

  await Promise.all(
    PUBLIC_COMMENT_CACHE_NAMESPACES.map(async (namespace) => {
      await kv.delete(await getPublicMarkerCommentCacheKey(namespace, markerId));
    })
  );
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

export async function listCachedPublicCommentsByMarker(
  payload: {
    db: D1Database;
    kv?: KVNamespace;
    markerIds: string[];
    limit: number;
    replyLimit: number;
    cacheNamespace: PublicCommentCacheNamespace;
    waitUntil: (promise: Promise<unknown>) => void;
  }
): Promise<PublicSubmissionComment[]> {
  const grouped = new Map<string, PublicSubmissionComment[]>();
  const missingIds: string[] = [];

  if (payload.kv) {
    const cacheResults = await Promise.all(
      [...new Set(payload.markerIds)].map(async (markerId) => ({
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
    missingIds.push(...new Set(payload.markerIds));
  }

  for (let offset = 0; offset < missingIds.length; offset += 100) {
    const markerIds = missingIds.slice(offset, offset + 100);
    const items = await listActiveCommentsByMarker(payload.db, {
      markerIds,
      limit: PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
      replyLimit: PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT,
    });
    const loaded = groupPublicCommentsByMarker(markerIds, items);
    for (const [markerId, values] of loaded) grouped.set(markerId, values);
    if (payload.kv) {
      payload.waitUntil(Promise.all(markerIds.map((markerId) => (
        writePublicMarkerCommentCache(payload.kv, payload.cacheNamespace, markerId, loaded.get(markerId)!)
      ))).catch(() => undefined));
    }
  }

  return flattenPublicCommentsByMarker(payload.markerIds, grouped, payload.limit, payload.replyLimit);
}
