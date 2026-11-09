import { sha256Hex } from "@/lib/crypto";
import { DEFAULT_KV_READ_CACHE_TTL_SECONDS, getJsonFromKv, putJsonToKv } from "@/lib/kvJson";
import {
  PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
  PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT,
  type PublicCommentCacheNamespace,
} from "@/publicRead/contract/markers";
import { listActiveCommentsByMarker } from "@/repositories/submission/listComments";
import type { PublicCommentNode } from "@/repositories/submission/types";
import { selectCommentBranches } from "@/services/ugc/read/commentTree";

export const PUBLIC_MARKER_COMMENT_POSITIVE_TTL_SECONDS = 90 * 24 * 60 * 60;
export const PUBLIC_MARKER_COMMENT_EMPTY_TTL_SECONDS = 10 * 60;

const PUBLIC_COMMENT_CACHE_NAMESPACES = ["default", "test", "prod"] as const;

type PublicMarkerCommentCacheEntry = {
  items: PublicCommentNode[];
};

async function getPublicMarkerCommentCacheKey(
  namespace: PublicCommentCacheNamespace,
  markerId: string,
  includeReplies: boolean,
): Promise<string> {
  const version = "v4";
  return `ugc:marker-comments:${version}:${namespace}:${includeReplies ? "tree" : "roots"}:${await sha256Hex(markerId)}`;
}

async function readPublicMarkerCommentCache(
  kv: KVNamespace | undefined,
  namespace: PublicCommentCacheNamespace,
  markerId: string,
  includeReplies: boolean,
): Promise<PublicCommentNode[] | null> {
  if (!kv) {
    return null;
  }

  const entry = await getJsonFromKv<PublicMarkerCommentCacheEntry>(
    kv,
    await getPublicMarkerCommentCacheKey(namespace, markerId, includeReplies),
    { cacheTtl: DEFAULT_KV_READ_CACHE_TTL_SECONDS },
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
  items: PublicCommentNode[],
  includeReplies: boolean,
): Promise<void> {
  if (!kv) {
    return;
  }

  const expirationTtl =
    items.length > 0
      ? PUBLIC_MARKER_COMMENT_POSITIVE_TTL_SECONDS
      : PUBLIC_MARKER_COMMENT_EMPTY_TTL_SECONDS;

  await putJsonToKv(
    kv,
    await getPublicMarkerCommentCacheKey(namespace, markerId, includeReplies),
    { items },
    { expirationTtl },
  );
}

export async function deletePublicMarkerCommentCache(
  kv: KVNamespace | undefined,
  markerId: string,
): Promise<void> {
  if (!kv) {
    return;
  }

  await Promise.all(
    PUBLIC_COMMENT_CACHE_NAMESPACES.flatMap((namespace) =>
      [false, true].map(async (includeReplies) => {
        await kv.delete(await getPublicMarkerCommentCacheKey(namespace, markerId, includeReplies));
      }),
    ),
  );
}

function groupPublicCommentsByMarker(
  markerIds: string[],
  comments: PublicCommentNode[],
): Map<string, PublicCommentNode[]> {
  const grouped = new Map<string, PublicCommentNode[]>();
  markerIds.forEach((markerId) => grouped.set(markerId, []));
  comments.forEach((comment) => {
    const bucket = grouped.get(comment.markerId);
    if (bucket) {
      bucket.push(comment);
    }
  });
  return grouped;
}

function flattenPublicCommentsByMarker(
  markerIds: string[],
  grouped: Map<string, PublicCommentNode[]>,
  limit: number,
  replyLimit: number,
): PublicCommentNode[] {
  return markerIds.flatMap((markerId) =>
    selectCommentBranches(grouped.get(markerId) ?? [], limit, replyLimit),
  );
}

export async function listCachedPublicCommentsByMarker(payload: {
  db: D1Database;
  kv?: KVNamespace;
  markerIds: string[];
  limit: number;
  replyLimit: number;
  cacheNamespace: PublicCommentCacheNamespace;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<PublicCommentNode[]> {
  const grouped = new Map<string, PublicCommentNode[]>();
  const missingIds: string[] = [];

  if (payload.kv) {
    const cacheResults = await Promise.all(
      [...new Set(payload.markerIds)].map(async (markerId) => ({
        markerId,
        comments: await readPublicMarkerCommentCache(
          payload.kv,
          payload.cacheNamespace,
          markerId,
          payload.replyLimit > 0,
        ),
      })),
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
      replyLimit: payload.replyLimit > 0 ? PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT : 0,
    });
    const loaded = groupPublicCommentsByMarker(markerIds, items);
    for (const [markerId, values] of loaded) {
      grouped.set(markerId, values);
    }
    if (payload.kv) {
      payload.waitUntil(
        Promise.all(
          markerIds.map((markerId) =>
            writePublicMarkerCommentCache(
              payload.kv,
              payload.cacheNamespace,
              markerId,
              loaded.get(markerId)!,
              payload.replyLimit > 0,
            ),
          ),
        ).catch(() => undefined),
      );
    }
  }

  return flattenPublicCommentsByMarker(
    payload.markerIds,
    grouped,
    payload.limit,
    payload.replyLimit,
  );
}
