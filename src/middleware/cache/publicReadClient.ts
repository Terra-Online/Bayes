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

async function readItems<T>(responses: Response[]): Promise<T[][] | Response> {
  const failed = responses.find((response) => !response.ok);
  if (failed) {
    await Promise.all(responses
      .filter((response) => response !== failed)
      .map((response) => response.body?.cancel().catch(() => undefined)));
    return new Response(failed.body, {
      status: failed.status,
      statusText: failed.statusText,
      headers: {
        "content-type": failed.headers.get("content-type") ?? "application/json; charset=utf-8",
        "Cache-Control": "private, no-store"
      }
    });
  }

  try {
    return await Promise.all(responses.map(async (response) => {
      const payload = await response.json() as { items?: T[] };
      if (!Array.isArray(payload.items)) {
        throw new Error("Public cache response did not contain an items array.");
      }
      return payload.items;
    }));
  } catch (error) {
    console.warn("Workers Cache response parsing failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return noStoreError(502, "Public cache returned an invalid response.");
  }
}

function combinedResponse(
  items: unknown[],
  cacheControl: string,
  markerHeader: string
): Response {
  return new Response(JSON.stringify({ items }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      [markerHeader]: "enabled",
      "x-oem-workers-cache": "per-marker"
    }
  });
}

export async function fetchPublicImagesFromWorkersCache(payload: {
  markerIds: string[];
  limit: number;
  cacheNamespace: PublicReadCacheNamespace;
  assetBaseUrl: string;
}): Promise<Response> {
  const markerIds = normalizePublicReadMarkerIds(payload.markerIds);
  const responses = await Promise.all(markerIds.map((markerId) => fetchSingleMarker(
    PUBLIC_READ_IMAGES_PATH,
    buildPublicImagesSearchParams({
      markerIds: [markerId],
      limit: PUBLIC_MARKER_IMAGE_CACHE_LIMIT,
      cacheNamespace: payload.cacheNamespace,
      assetBaseUrl: payload.assetBaseUrl
    })
  )));
  const markerItems = await readItems<PublicSubmissionImage>(responses);
  if (markerItems instanceof Response) return markerItems;

  const items = markerItems.flatMap((images) => images.slice(0, payload.limit));
  return combinedResponse(
    items,
    items.length > 0 ? UGC_PUBLIC_LIST_CACHE_CONTROL : UGC_PUBLIC_EMPTY_LIST_CACHE_CONTROL,
    "x-oem-marker-kv-cache"
  );
}

export async function fetchPublicCommentsFromWorkersCache(payload: {
  markerIds: string[];
  limit: number;
  replyLimit: number;
  cacheNamespace: PublicReadCacheNamespace;
}): Promise<Response> {
  const markerIds = normalizePublicReadMarkerIds(payload.markerIds);
  const responses = await Promise.all(markerIds.map((markerId) => fetchSingleMarker(
    PUBLIC_READ_COMMENTS_PATH,
    buildPublicCommentsSearchParams({
      markerIds: [markerId],
      limit: PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
      replyLimit: PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT,
      cacheNamespace: payload.cacheNamespace
    })
  )));
  const markerItems = await readItems<PublicSubmissionComment>(responses);
  if (markerItems instanceof Response) return markerItems;

  const items = markerItems.flatMap((comments) => comments
    .slice(0, payload.limit)
    .map((comment) => ({
      ...comment,
      replies: comment.replies.slice(0, payload.replyLimit)
    })));
  return combinedResponse(
    items,
    items.length > 0 ? "public, max-age=15" : "public, max-age=5",
    "x-oem-marker-comment-kv-cache"
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
