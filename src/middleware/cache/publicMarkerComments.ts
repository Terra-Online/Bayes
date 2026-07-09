import type { PublicSubmissionComment } from "../../repositories/submission/types";
import { getJsonFromKv, putJsonToKv, sha256Hex } from "./kvJson";

export const PUBLIC_MARKER_COMMENT_CACHE_LIMIT = 50;
export const PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT = 5;

const PUBLIC_MARKER_COMMENT_KV_KEY_PREFIX = "ugc:marker-comments:v2:";
const PUBLIC_MARKER_COMMENT_POSITIVE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PUBLIC_MARKER_COMMENT_EMPTY_TTL_SECONDS = 10 * 60;
const PUBLIC_COMMENT_CACHE_NAMESPACES = ["default", "test", "prod"] as const;

export type PublicCommentCacheNamespace = typeof PUBLIC_COMMENT_CACHE_NAMESPACES[number];

type PublicMarkerCommentCacheEntry = {
  items: PublicSubmissionComment[];
};

export function resolvePublicCommentCacheNamespace(scope: { pathPrefix?: string; excludePathPrefix?: string }): PublicCommentCacheNamespace {
  if (scope.pathPrefix === "_test") {
    return "test";
  }
  if (scope.excludePathPrefix === "_test") {
    return "prod";
  }
  return "default";
}

async function getPublicMarkerCommentCacheKey(
  namespace: PublicCommentCacheNamespace,
  markerId: string
): Promise<string> {
  return `${PUBLIC_MARKER_COMMENT_KV_KEY_PREFIX}${namespace}:${await sha256Hex(markerId)}`;
}

export async function readPublicMarkerCommentCache(
  kv: KVNamespace | undefined,
  namespace: PublicCommentCacheNamespace,
  markerId: string
): Promise<PublicSubmissionComment[] | null> {
  if (!kv) return null;

  const entry = await getJsonFromKv<PublicMarkerCommentCacheEntry>(
    kv,
    await getPublicMarkerCommentCacheKey(namespace, markerId)
  );
  if (!entry || !Array.isArray(entry.items)) {
    return null;
  }

  return entry.items;
}

export async function writePublicMarkerCommentCache(
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
