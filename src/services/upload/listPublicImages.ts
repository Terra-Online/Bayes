import { getRuntimeConfig } from "../../lib/config";
import { ApiError } from "../../lib/errors";
import {
  PUBLIC_MARKER_IMAGE_CACHE_LIMIT,
  readPublicMarkerImageCache,
  resolvePublicImageCacheNamespace,
  writePublicMarkerImageCache
} from "../../middleware/cache/publicMarkerImages";
import { fetchPublicImagesFromWorkersCache } from "../../middleware/cache/publicReadClient";
import { listActiveImagesByMarker, listUserImagesByMarker } from "../../repositories/submission/listImages";
import type { PublicSubmissionImage } from "../../repositories/submission/types";
import type { AppEnv } from "../../types/app";
import { getOptionalSession, hasAuthHeaders, requireMarkerIds } from "./helpers";
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
    limit: c.req.query("limit"),
    publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
  }

  const ids = requireMarkerIds(parsed.data);
  const config = getRuntimeConfig(c.env);
  const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
  const limit = parsed.data.limit ?? 6;
  const shouldReadSession = parsed.data.publicOnly !== "1" && hasAuthHeaders(c.req.raw.headers);
  const session = shouldReadSession
    ? await getOptionalSession(c.env, c.req.raw.headers)
    : null;
  const useSharedCache = parsed.data.publicOnly === "1" || !session;
  const assetBaseUrl = resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl);
  if (useSharedCache) {
    return fetchPublicImagesFromWorkersCache({
      markerIds: ids,
      limit,
      cacheNamespace: resolvePublicImageCacheNamespace(scope),
      assetBaseUrl
    });
  }

  const images = await listActiveImagesByMarker(c.env.DB, {
    markerIds: ids,
    assetBaseUrl,
    pathPrefix: scope.pathPrefix,
    excludePathPrefix: scope.excludePathPrefix,
    limit,
    viewerUserId: session?.user.id
  });

  const response = c.json({ items: images });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
