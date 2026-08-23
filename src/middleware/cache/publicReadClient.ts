import { exports as workerExports } from "cloudflare:workers";
import type {
  PublicSubmissionComment,
  PublicSubmissionImage
} from "../../repositories/submission/types";
import {
  PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
  PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT
} from "./publicMarkerComments";
import { PUBLIC_MARKER_IMAGE_CACHE_LIMIT } from "./publicMarkerImages";
import {
  buildPublicReadCacheKey,
  buildPublicReadMarkerTag,
  buildProgressStatsSearchParams,
  buildPublicCommentsSearchParams,
  buildPublicImagesSearchParams,
  normalizePublicReadMarkerIds,
  PUBLIC_READ_CACHE_ORIGIN,
  PUBLIC_READ_COMMENTS_PATH,
  PUBLIC_READ_IMAGES_PATH,
  PUBLIC_READ_PROGRESS_STATS_PATH,
  type PublicReadCacheNamespace,
  type PublicReadMarkerKind
} from "./publicReadKeys";
import {
  UGC_PUBLIC_EMPTY_LIST_CACHE_CONTROL,
  UGC_PUBLIC_LIST_CACHE_CONTROL
} from "./publicUgcAssets";

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

async function fetchSingleMarker(
  path: string,
  searchParams: URLSearchParams
): Promise<Response> {
  const { request, cacheKey } = createPublicReadRequest(path, searchParams);
  return fetchPublicRead(request, cacheKey);
}

function noStoreError(status: number, message: string): Response {
  return new Response(JSON.stringify({ code: "PUBLIC_CACHE_READ_FAILED", message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store"
    }
  });
}

type MarkerItemsResult<T> = {
  failedCount: number;
  items: T[][];
};

async function readItems<T>(requests: Promise<Response>[]): Promise<MarkerItemsResult<T> | Response> {
  const results = await Promise.allSettled(requests);
  const items: T[][] = [];
  let failedCount = 0;
  let failureStatus: number | undefined;

  for (const result of results) {
    if (result.status === "rejected") {
      failedCount += 1;
      continue;
    }

    const response = result.value;
    if (!response.ok) {
      failedCount += 1;
      failureStatus ??= response.status;
      await response.body?.cancel().catch(() => undefined);
      continue;
    }

    try {
      const payload = await response.json() as { items?: T[] };
      if (!Array.isArray(payload.items)) {
        throw new Error("Public cache response did not contain an items array.");
      }
      items.push(payload.items);
    } catch {
      failedCount += 1;
    }
  }

  if (items.length === 0 && failedCount > 0) {
    return noStoreError(failureStatus ?? 502, "Public cache reads failed.");
  }
  return { failedCount, items };
}

function combinedResponse(
  items: unknown[],
  cacheControl: string,
  markerHeader: string,
  failedCount = 0
): Response {
  const partial = failedCount > 0;
  return new Response(JSON.stringify({ items, ...(partial ? { partial: true } : {}) }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": partial ? "private, no-store" : cacheControl,
      [markerHeader]: "enabled",
      "x-oem-workers-cache": "per-marker",
      ...(partial ? {
        "x-oem-partial-response": "true",
        "x-oem-failed-marker-count": String(failedCount)
      } : {})
    }
  });
}

function logPartialRead(kind: PublicReadMarkerKind, failedCount: number, totalCount: number): void {
  if (failedCount === 0) return;
  console.error("[public-read] partial marker response", {
    kind,
    failedMarkerCount: failedCount,
    totalMarkerCount: totalCount
  });
}

export async function fetchPublicImagesFromWorkersCache(payload: {
  markerIds: string[];
  limit: number;
  cacheNamespace: PublicReadCacheNamespace;
  assetBaseUrl: string;
}): Promise<Response> {
  const markerIds = normalizePublicReadMarkerIds(payload.markerIds);
  const markerItems = await readItems<PublicSubmissionImage>(markerIds.map((markerId) => fetchSingleMarker(
    PUBLIC_READ_IMAGES_PATH,
    buildPublicImagesSearchParams({
      markerIds: [markerId],
      limit: PUBLIC_MARKER_IMAGE_CACHE_LIMIT,
      cacheNamespace: payload.cacheNamespace,
      assetBaseUrl: payload.assetBaseUrl
    })
  )));
  if (markerItems instanceof Response) return markerItems;

  logPartialRead("image", markerItems.failedCount, markerIds.length);
  const items = markerItems.items.flatMap((images) => images.slice(0, payload.limit));
  return combinedResponse(
    items,
    items.length > 0 ? UGC_PUBLIC_LIST_CACHE_CONTROL : UGC_PUBLIC_EMPTY_LIST_CACHE_CONTROL,
    "x-oem-marker-kv-cache",
    markerItems.failedCount
  );
}

export async function fetchPublicCommentsFromWorkersCache(payload: {
  markerIds: string[];
  limit: number;
  replyLimit: number;
  cacheNamespace: PublicReadCacheNamespace;
}): Promise<Response> {
  const markerIds = normalizePublicReadMarkerIds(payload.markerIds);
  const markerItems = await readItems<PublicSubmissionComment>(markerIds.map((markerId) => fetchSingleMarker(
    PUBLIC_READ_COMMENTS_PATH,
    buildPublicCommentsSearchParams({
      markerIds: [markerId],
      limit: PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
      replyLimit: PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT,
      cacheNamespace: payload.cacheNamespace
    })
  )));
  if (markerItems instanceof Response) return markerItems;

  logPartialRead("comment", markerItems.failedCount, markerIds.length);
  const items = markerItems.items.flatMap((comments) => comments
    .slice(0, payload.limit)
    .map((comment) => ({
      ...comment,
      replies: comment.replies.slice(0, payload.replyLimit)
    })));
  return combinedResponse(
    items,
    items.length > 0 ? "public, max-age=15" : "public, max-age=5",
    "x-oem-marker-comment-kv-cache",
    markerItems.failedCount
  );
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
