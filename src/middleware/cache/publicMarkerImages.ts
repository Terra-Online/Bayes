import type { PublicSubmissionImage } from "../../repositories/submission/types";
import {
  DEFAULT_KV_READ_CACHE_TTL_SECONDS,
  getJsonFromKv,
  putJsonToKv,
  sha256Hex
} from "./kvJson";
import { CACHE_KEY_VERSIONS } from "./versions";

export const PUBLIC_MARKER_IMAGE_CACHE_LIMIT = 24;
export const PUBLIC_MARKER_IMAGE_POSITIVE_TTL_SECONDS = 90 * 24 * 60 * 60;
export const PUBLIC_MARKER_IMAGE_EMPTY_TTL_SECONDS = 60 * 60;

const PUBLIC_MARKER_IMAGE_KV_KEY_PREFIX = `ugc:marker-images:${CACHE_KEY_VERSIONS.publicMarkerImages}:`;
const PUBLIC_IMAGE_CACHE_NAMESPACES = ["default", "test", "prod"] as const;

export type PublicImageCacheNamespace = typeof PUBLIC_IMAGE_CACHE_NAMESPACES[number];

type PublicMarkerImageCacheEntry = {
  items: PublicSubmissionImage[];
};

export function resolvePublicImageCacheNamespace(scope: { pathPrefix?: string; excludePathPrefix?: string }): PublicImageCacheNamespace {
  if (scope.pathPrefix === "_test") {
    return "test";
  }
  if (scope.excludePathPrefix === "_test") {
    return "prod";
  }
  return "default";
}

async function getPublicMarkerImageCacheKey(
  namespace: PublicImageCacheNamespace,
  markerId: string
): Promise<string> {
  return `${PUBLIC_MARKER_IMAGE_KV_KEY_PREFIX}${namespace}:${await sha256Hex(markerId)}`;
}

export async function readPublicMarkerImageCache(
  kv: KVNamespace | undefined,
  namespace: PublicImageCacheNamespace,
  markerId: string
): Promise<PublicSubmissionImage[] | null> {
  if (!kv) return null;

  const entry = await getJsonFromKv<PublicMarkerImageCacheEntry>(
    kv,
    await getPublicMarkerImageCacheKey(namespace, markerId),
    { cacheTtl: DEFAULT_KV_READ_CACHE_TTL_SECONDS }
  );
  if (!entry || !Array.isArray(entry.items)) {
    return null;
  }

  return entry.items;
}

export async function writePublicMarkerImageCache(
  kv: KVNamespace | undefined,
  namespace: PublicImageCacheNamespace,
  markerId: string,
  items: PublicSubmissionImage[]
): Promise<void> {
  if (!kv) return;

  const expirationTtl = items.length > 0
    ? PUBLIC_MARKER_IMAGE_POSITIVE_TTL_SECONDS
    : PUBLIC_MARKER_IMAGE_EMPTY_TTL_SECONDS;

  await putJsonToKv(
    kv,
    await getPublicMarkerImageCacheKey(namespace, markerId),
    { items },
    { expirationTtl }
  );
}

export async function deletePublicMarkerImageCache(
  kv: KVNamespace | undefined,
  markerId: string
): Promise<void> {
  if (!kv) return;

  await Promise.all(
    PUBLIC_IMAGE_CACHE_NAMESPACES.map(async (namespace) => {
      await kv.delete(await getPublicMarkerImageCacheKey(namespace, markerId));
    })
  );
}
