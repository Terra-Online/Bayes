import { exports as workerExports } from "cloudflare:workers";
import {
  buildPublicReadCacheKey,
  buildPublicReadMarkerTag,
  buildProgressStatsSearchParams,
  buildPublicCommentsSearchParams,
  buildPublicImagesSearchParams,
  PUBLIC_READ_CACHE_ORIGIN,
  PUBLIC_READ_COMMENTS_PATH,
  PUBLIC_READ_IMAGES_PATH,
  PUBLIC_READ_PROGRESS_STATS_PATH,
  type PublicReadCacheNamespace,
  type PublicReadMarkerKind
} from "./publicReadKeys";

function createPublicReadRequest(path: string, searchParams: URLSearchParams): {
  request: Request;
  cacheKey: string;
} {
  const url = new URL(path, PUBLIC_READ_CACHE_ORIGIN);
  url.search = searchParams.toString();
  return {
    request: new Request(url, { method: "GET" }),
    cacheKey: buildPublicReadCacheKey(path, searchParams)
  };
}

async function fetchPublicRead(request: Request, cacheKey: string): Promise<Response> {
  return workerExports.PublicReadCache.fetch(request, {
    cf: { cacheKey }
  });
}

export async function fetchPublicImagesFromWorkersCache(payload: {
  markerIds: string[];
  limit: number;
  cacheNamespace: PublicReadCacheNamespace;
  assetBaseUrl: string;
}): Promise<Response> {
  const searchParams = buildPublicImagesSearchParams(payload);
  const { request, cacheKey } = createPublicReadRequest(PUBLIC_READ_IMAGES_PATH, searchParams);
  return fetchPublicRead(request, cacheKey);
}

export async function fetchPublicCommentsFromWorkersCache(payload: {
  markerIds: string[];
  limit: number;
  replyLimit: number;
  cacheNamespace: PublicReadCacheNamespace;
}): Promise<Response> {
  const searchParams = buildPublicCommentsSearchParams(payload);
  const { request, cacheKey } = createPublicReadRequest(PUBLIC_READ_COMMENTS_PATH, searchParams);
  return fetchPublicRead(request, cacheKey);
}

export async function fetchProgressStatsFromWorkersCache(markerIndexHash: string): Promise<Response> {
  const searchParams = buildProgressStatsSearchParams(markerIndexHash);
  const { request, cacheKey } = createPublicReadRequest(PUBLIC_READ_PROGRESS_STATS_PATH, searchParams);
  return fetchPublicRead(request, cacheKey);
}

export async function purgePublicMarkerResponseCache(
  kind: PublicReadMarkerKind,
  markerId: string
): Promise<void> {
  try {
    const result = await workerExports.PublicReadCache.purgeMarker(kind, markerId);
    if (!result.success) {
      console.warn("Workers Cache marker purge failed", {
        kind,
        markerTag: await buildPublicReadMarkerTag(kind, markerId),
        errors: result.errors
      });
    }
  } catch (error) {
    console.warn("Workers Cache marker purge failed", {
      kind,
      markerTag: await buildPublicReadMarkerTag(kind, markerId),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
