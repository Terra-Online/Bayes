import { getRuntimeConfig } from "../../lib/config";
import { ApiError } from "../../lib/errors";
import { InFlightBatchLoader } from "../../middleware/cache/inFlightBatchLoader";
import {
  PUBLIC_MARKER_IMAGE_CACHE_LIMIT,
  readPublicMarkerImageCache,
  resolvePublicImageCacheNamespace,
  writePublicMarkerImageCache
} from "../../middleware/cache/publicMarkerImages";
import { fetchPublicImagesFromWorkersCache } from "../../middleware/cache/publicReadClient";
import {
  listActiveImagesByMarker,
  listImageViewerReactionsByMarker,
  listUserImagesByMarker
} from "../../repositories/submission/listImages";
import type { PublicSubmissionImage } from "../../repositories/submission/types";
import type { AppEnv } from "../../types/app";
import { getOptionalAuthIdentity, hasAuthHeaders, requireMarkerIds } from "./helpers";
import { imagesQuerySchema } from "./schemas";
import { resolveImageScope, resolvePrivateAssetBaseUrl, resolvePublicAssetBaseUrl } from "./scope";
import { applyImageViewerReactions } from "./viewerOverlay";

const imageLoadersByDb = new WeakMap<
  D1Database,
  Map<string, InFlightBatchLoader<PublicSubmissionImage[]>>
>();

function getPublicImageLoader(payload: {
  db: D1Database;
  assetBaseUrl: string;
  pathPrefix?: string;
  excludePathPrefix?: string;
  cacheNamespace: ReturnType<typeof resolvePublicImageCacheNamespace>;
}): InFlightBatchLoader<PublicSubmissionImage[]> {
  let loaders = imageLoadersByDb.get(payload.db);
  if (!loaders) {
    loaders = new Map();
    imageLoadersByDb.set(payload.db, loaders);
  }

  const loaderKey = JSON.stringify([
    payload.cacheNamespace,
    payload.assetBaseUrl,
    payload.pathPrefix ?? null,
    payload.excludePathPrefix ?? null
  ]);
  let loader = loaders.get(loaderKey);
  if (!loader) {
    loader = new InFlightBatchLoader<PublicSubmissionImage[]>();
    loaders.set(loaderKey, loader);
  }
  return loader;
}

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
    const loader = getPublicImageLoader(payload);
    const loaded = await Promise.all(missingIds.map(async (markerId) => ({
      markerId,
      images: await loader.load(markerId, async (markerIds) => {
        const dbImages = await listActiveImagesByMarker(payload.db, {
          markerIds,
          assetBaseUrl: payload.assetBaseUrl,
          pathPrefix: payload.pathPrefix,
          excludePathPrefix: payload.excludePathPrefix,
          limit: PUBLIC_MARKER_IMAGE_CACHE_LIMIT
        });
        const dbGrouped = groupPublicImagesByMarker(markerIds, dbImages);
        if (payload.kv) {
          payload.waitUntil(Promise.all(markerIds.map((missingMarkerId) => (
            writePublicMarkerImageCache(
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

    loaded.forEach(({ markerId, images }) => {
      grouped.set(markerId, images);
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
  const assetBaseUrl = resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl);
  const publicResponsePromise = fetchPublicImagesFromWorkersCache({
    markerIds: ids,
    limit,
    cacheNamespace: resolvePublicImageCacheNamespace(scope),
    assetBaseUrl
  });

  if (parsed.data.publicOnly === "1" || !hasAuthHeaders(c.req.raw.headers)) {
    return publicResponsePromise;
  }

  const [publicResponse, identity] = await Promise.all([
    publicResponsePromise,
    getOptionalAuthIdentity(c.env, c.req.raw.headers)
  ]);
  if (!identity || !publicResponse.ok) return publicResponse;

  const payload = await publicResponse.json() as { items: PublicSubmissionImage[]; partial?: boolean };
  const reactions = await listImageViewerReactionsByMarker(c.env.DB, {
    userId: identity.uid,
    markerIds: ids,
    submissionIds: payload.items.map((image) => image.id),
    pathPrefix: scope.pathPrefix,
    excludePathPrefix: scope.excludePathPrefix
  });
  const images = applyImageViewerReactions(payload.items, reactions);

  const response = c.json({ ...payload, items: images });
  for (const header of ["x-oem-partial-response", "x-oem-failed-marker-count"]) {
    const value = publicResponse.headers.get(header);
    if (value !== null) response.headers.set(header, value);
  }
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("x-oem-viewer-overlay", "image");
  return response;
}
