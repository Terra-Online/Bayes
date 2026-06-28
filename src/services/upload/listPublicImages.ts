import { createAuth } from "../../lib/auth/createAuth";
import { getRuntimeConfig } from "../../lib/config";
import { ApiError } from "../../lib/errors";
import {
  PUBLIC_MARKER_IMAGE_CACHE_LIMIT,
  readPublicMarkerImageCache,
  resolvePublicImageCacheNamespace,
  writePublicMarkerImageCache
} from "../../middleware/cache/publicMarkerImages";
import {
  UGC_PUBLIC_EMPTY_LIST_CACHE_CONTROL,
  UGC_PUBLIC_LIST_CACHE_CONTROL
} from "../../middleware/cache/publicUgcAssets";
import { listActiveImagesByMarker, listUserImagesByMarker } from "../../repositories/submission/listImages";
import type { PublicSubmissionImage } from "../../repositories/submission/types";
import type { AppEnv } from "../../types/app";
import { requireMarkerIds } from "./helpers";
import { imagesQuerySchema } from "./schemas";
import { resolveImageScope, resolvePrivateAssetBaseUrl, resolvePublicAssetBaseUrl } from "./scope";

function groupPublicImagesByMarker(
  markerIds: string[],
  images: PublicSubmissionImage[]
): Map<string, PublicSubmissionImage[]> {
  const grouped = new Map<string, PublicSubmissionImage[]>();
  markerIds.forEach((markerId) => grouped.set(markerId, []));
  images.forEach((image) => {
    const bucket = grouped.get(image.markerId);
    if (bucket) {
      bucket.push(image);
    }
  });
  return grouped;
}

function flattenPublicImagesByMarker(
  markerIds: string[],
  grouped: Map<string, PublicSubmissionImage[]>,
  limit: number
): PublicSubmissionImage[] {
  return markerIds.flatMap((markerId) => (grouped.get(markerId) ?? []).slice(0, limit));
}

export async function listCachedPublicImagesByMarker(
  payload: {
    db: D1Database;
    kv?: KVNamespace;
    markerIds: string[];
    assetBaseUrl: string;
    pathPrefix?: string;
    excludePathPrefix?: string;
    limit: number;
    cacheNamespace: ReturnType<typeof resolvePublicImageCacheNamespace>;
    waitUntil: (promise: Promise<unknown>) => void;
  }
): Promise<PublicSubmissionImage[]> {
  const grouped = new Map<string, PublicSubmissionImage[]>();
  const missingIds: string[] = [];

  if (payload.kv) {
    const cacheResults = await Promise.all(
      payload.markerIds.map(async (markerId) => ({
        markerId,
        images: await readPublicMarkerImageCache(payload.kv, payload.cacheNamespace, markerId)
      }))
    );

    cacheResults.forEach(({ markerId, images }) => {
      if (images) {
        grouped.set(markerId, images);
      } else {
        missingIds.push(markerId);
      }
    });
  } else {
    missingIds.push(...payload.markerIds);
  }

  if (missingIds.length > 0) {
    const dbImages = await listActiveImagesByMarker(payload.db, {
      markerIds: missingIds,
      assetBaseUrl: payload.assetBaseUrl,
      pathPrefix: payload.pathPrefix,
      excludePathPrefix: payload.excludePathPrefix,
      limit: PUBLIC_MARKER_IMAGE_CACHE_LIMIT
    });
    const dbGrouped = groupPublicImagesByMarker(missingIds, dbImages);

    missingIds.forEach((markerId) => {
      const images = dbGrouped.get(markerId) ?? [];
      grouped.set(markerId, images);
      if (payload.kv) {
        payload.waitUntil(writePublicMarkerImageCache(
          payload.kv,
          payload.cacheNamespace,
          markerId,
          images
        ));
      }
    });
  }

  return flattenPublicImagesByMarker(payload.markerIds, grouped, payload.limit);
}

export async function handleListMyImages(c: import("hono").Context<AppEnv>) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }

  const parsed = imagesQuerySchema.safeParse({
    markerId: c.req.query("markerId"),
    markerIds: c.req.query("markerIds"),
    scope: c.req.query("scope"),
    limit: c.req.query("limit"),
    publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
  }

  const ids = requireMarkerIds(parsed.data, false);
  const config = getRuntimeConfig(c.env);
  const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
  const items = await listUserImagesByMarker(c.env.DB, {
    userId: user.uid,
    markerIds: ids,
    assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
    privateAssetBaseUrl: resolvePrivateAssetBaseUrl(c.req.url),
    pathPrefix: scope.pathPrefix,
    excludePathPrefix: scope.excludePathPrefix,
    limit: parsed.data.limit ?? 6
  });

  const response = c.json({ items });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function handleListPublicImages(c: import("hono").Context<AppEnv>) {
  const parsed = imagesQuerySchema.safeParse({
    markerId: c.req.query("markerId"),
    markerIds: c.req.query("markerIds"),
    scope: c.req.query("scope"),
    limit: c.req.query("limit")
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
  }

  const ids = requireMarkerIds(parsed.data);
  const config = getRuntimeConfig(c.env);
  const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
  const limit = parsed.data.limit ?? 6;
  const session = parsed.data.publicOnly === "1"
    ? null
    : await createAuth(c.env).api.getSession({
      headers: c.req.raw.headers
    });
  const useSharedCache = parsed.data.publicOnly === "1" || !session;
  let cache: Cache | null = null;
  let cacheKey: Request | null = null;
  if (useSharedCache) {
    cache = await caches.open("ugc-images");
    const cacheNamespace = resolvePublicImageCacheNamespace(scope);
    const cacheUrl = new URL(c.req.url);
    cacheUrl.searchParams.delete("markerId");
    cacheUrl.searchParams.set("markerIds", [...ids].sort().join(","));
    cacheUrl.searchParams.set("limit", String(limit));
    cacheUrl.searchParams.set("_cache_ns", cacheNamespace);
    cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const assetBaseUrl = resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl);
  const images = useSharedCache
    ? await listCachedPublicImagesByMarker({
      db: c.env.DB,
      kv: c.env.OEM_KV,
      markerIds: ids,
      assetBaseUrl,
      pathPrefix: scope.pathPrefix,
      excludePathPrefix: scope.excludePathPrefix,
      limit,
      cacheNamespace: resolvePublicImageCacheNamespace(scope),
      waitUntil: (promise) => c.executionCtx.waitUntil(promise)
    })
    : await listActiveImagesByMarker(c.env.DB, {
      markerIds: ids,
      assetBaseUrl,
      pathPrefix: scope.pathPrefix,
      excludePathPrefix: scope.excludePathPrefix,
      limit,
      viewerUserId: session?.user.id
    });

  const response = c.json({ items: images });
  if (cache && cacheKey) {
    response.headers.set(
      "Cache-Control",
      images.length > 0 ? UGC_PUBLIC_LIST_CACHE_CONTROL : UGC_PUBLIC_EMPTY_LIST_CACHE_CONTROL
    );
    response.headers.set("x-oem-marker-kv-cache", "enabled");
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  } else {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
