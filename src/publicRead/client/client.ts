import { exports as workerExports } from "cloudflare:workers";

import { transientDependencyError } from "../../lib/errors";
import type {
  PublicSubmissionComment,
  PublicSubmissionImage,
} from "../../repositories/submission/types";
import { buildPublicReadCacheKey, buildPublicReadMarkerTag } from "../contract/cacheKeys";
import {
  PUBLIC_EMPTY_IMAGE_LIST_CACHE_CONTROL,
  PUBLIC_IMAGE_LIST_CACHE_CONTROL,
} from "../contract/cachePolicy";
import {
  PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
  PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT,
  PUBLIC_MARKER_IMAGE_CACHE_LIMIT,
  type PublicReadCacheNamespace,
  type PublicReadMarkerKind,
  type PublicMarkerListResponse,
} from "../contract/markers";
import {
  buildProgressStatsSearchParams,
  buildPublicCommentsSearchParams,
  buildPublicImagesSearchParams,
  normalizePublicReadMarkerIds,
  PUBLIC_READ_CACHE_ORIGIN,
  PUBLIC_READ_COMMENTS_PATH,
  PUBLIC_READ_IMAGES_PATH,
  PUBLIC_READ_PROGRESS_STATS_PATH,
} from "../contract/requests";

function createPublicReadRequest(
  path: string,
  searchParams: URLSearchParams,
): {
  request: Request;
  cacheKey: string;
} {
  const url = new URL(path, PUBLIC_READ_CACHE_ORIGIN);
  url.search = searchParams.toString();
  return {
    request: new Request(url, { method: "GET" }),
    cacheKey: buildPublicReadCacheKey(path, searchParams),
  };
}

async function fetchPublicRead(request: Request, cacheKey: string): Promise<Response> {
  return workerExports.PublicReadCache.fetch(request, {
    cf: { cacheKey },
  });
}

async function fetchSingleMarker(path: string, searchParams: URLSearchParams): Promise<Response> {
  const { request, cacheKey } = createPublicReadRequest(path, searchParams);
  return fetchPublicRead(request, cacheKey);
}

function noStoreError(status: number, message: string): Response {
  return new Response(JSON.stringify({ code: "PUBLIC_CACHE_READ_FAILED", message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      ...(status === 503 ? { "retry-after": "5" } : {}),
    },
  });
}

type MarkerItemsResult<T> = {
  failedCount: number;
  failedMarkerIds: string[];
  items: T[][];
};

async function readItems<T>(
  markerIds: string[],
  request: (markerId: string) => Promise<Response>,
  kind: PublicReadMarkerKind,
  selectItems: (items: T[]) => T[],
): Promise<MarkerItemsResult<T> | Response> {
  let nextIndex = 0;
  const results: Array<T[] | undefined> = new Array(markerIds.length);
  let failureStatus: number | undefined;
  const failures: Array<{
    stage: "fetch" | "body";
    upstreamStatus?: number;
    message: string;
    elapsedMs: number;
  }> = [];
  await Promise.all(
    Array.from({ length: Math.min(8, markerIds.length) }, async () => {
      while (nextIndex < markerIds.length) {
        const index = nextIndex++;
        const startedAt = Date.now();
        let stage: "fetch" | "body" = "fetch";
        let upstreamStatus: number | undefined;
        try {
          const response = await request(markerIds[index]!);
          upstreamStatus = response.status;
          if (!response.ok) {
            failureStatus ??= response.status;
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Public cache read failed: ${response.status}`);
          }
          stage = "body";
          const payload = (await response.json()) as Partial<PublicMarkerListResponse<T>>;
          if (!Array.isArray(payload.items)) {
            throw new Error("Public cache response did not contain an items array.");
          }
          results[index] = selectItems(payload.items);
        } catch (reason) {
          if (transientDependencyError(reason)) {
            failureStatus = 503;
          }
          if (failures.length < 3) {
            failures.push({
              stage,
              upstreamStatus,
              message: (reason instanceof Error ? reason.message : String(reason)).slice(0, 300),
              elapsedMs: Date.now() - startedAt,
            });
          }
        }
      }
    }),
  );
  const items: T[][] = [];
  let failedCount = 0;
  const failedMarkerIds: string[] = [];

  for (const [index, result] of results.entries()) {
    if (result === undefined) {
      failedCount += 1;
      failedMarkerIds.push(markerIds[index]!);
      continue;
    }

    items.push(result);
  }

  if (failedCount > 0) {
    console.error(
      items.length > 0
        ? "[public-read] partial marker response"
        : "[public-read] all marker reads failed",
      {
        kind,
        failedMarkerCount: failedCount,
        totalMarkerCount: markerIds.length,
        failures,
      },
    );
  }
  if (items.length === 0 && failedCount > 0) {
    return noStoreError(failureStatus ?? 502, "Public cache reads failed.");
  }
  return { failedCount, failedMarkerIds, items };
}

async function readSingleItem<T>(
  request: () => Promise<Response>,
  kind: PublicReadMarkerKind,
  selectItems: (items: T[]) => T[],
): Promise<MarkerItemsResult<T> | Response> {
  const startedAt = Date.now();
  let stage: "fetch" | "body" = "fetch";
  let upstreamStatus: number | undefined;
  try {
    const response = await request();
    upstreamStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Public cache read failed: ${response.status}`);
    }
    stage = "body";
    const payload = (await response.json()) as { items?: T[] };
    if (!Array.isArray(payload.items)) {
      throw new Error("Public cache response did not contain an items array.");
    }
    return { failedCount: 0, failedMarkerIds: [], items: [selectItems(payload.items)] };
  } catch (reason) {
    const transient = Boolean(transientDependencyError(reason));
    console.error("[public-read] single marker read failed", {
      kind,
      stage,
      upstreamStatus,
      elapsedMs: Date.now() - startedAt,
      transient,
      message: (reason instanceof Error ? reason.message : String(reason)).slice(0, 300),
    });
    return noStoreError(transient ? 503 : (upstreamStatus ?? 502), "Public cache reads failed.");
  }
}

export type PublicReadResult<T> = {
  payload: { items: T[]; partial?: boolean; failedMarkerIds?: string[] };
  headers: Record<string, string>;
};

export function publicReadResponse<T>(result: PublicReadResult<T> | Response): Response {
  return result instanceof Response
    ? result
    : Response.json(result.payload, { headers: result.headers });
}

function combinedResult<T>(
  items: T[],
  cacheControl: string,
  markerHeader: string,
  failedCount = 0,
  failedMarkerIds: string[] = [],
): PublicReadResult<T> {
  const partial = failedCount > 0;
  return {
    payload: { items, ...(partial ? { partial: true, failedMarkerIds } : {}) },
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": partial ? "private, no-store" : cacheControl,
      [markerHeader]: "enabled",
      "x-oem-workers-cache": "per-marker",
      ...(partial
        ? {
            "x-oem-partial-response": "true",
            "x-oem-failed-marker-count": String(failedCount),
          }
        : {}),
    },
  };
}

export async function readPublicImagesFromWorkersCache(payload: {
  markerIds: string[];
  limit: number;
  cacheNamespace: PublicReadCacheNamespace;
  assetBaseUrl: string;
}): Promise<PublicReadResult<PublicSubmissionImage> | Response> {
  const markerIds = normalizePublicReadMarkerIds(payload.markerIds);
  const request = (markerId: string) =>
    fetchSingleMarker(
      PUBLIC_READ_IMAGES_PATH,
      buildPublicImagesSearchParams({
        markerIds: [markerId],
        limit: PUBLIC_MARKER_IMAGE_CACHE_LIMIT,
        cacheNamespace: payload.cacheNamespace,
        assetBaseUrl: payload.assetBaseUrl,
      }),
    );
  const markerItems =
    markerIds.length === 1
      ? await readSingleItem<PublicSubmissionImage>(
          () => request(markerIds[0]!),
          "image",
          (images) => images.slice(0, payload.limit),
        )
      : await readItems<PublicSubmissionImage>(markerIds, request, "image", (images) =>
          images.slice(0, payload.limit),
        );
  if (markerItems instanceof Response) {
    return markerItems;
  }

  const items = markerItems.items.flat();
  return combinedResult(
    items,
    items.length > 0 ? PUBLIC_IMAGE_LIST_CACHE_CONTROL : PUBLIC_EMPTY_IMAGE_LIST_CACHE_CONTROL,
    "x-oem-marker-kv-cache",
    markerItems.failedCount,
    markerItems.failedMarkerIds,
  );
}

export async function readPublicCommentsFromWorkersCache(payload: {
  markerIds: string[];
  limit: number;
  replyLimit: number;
  cacheNamespace: PublicReadCacheNamespace;
}): Promise<PublicReadResult<PublicSubmissionComment> | Response> {
  const markerIds = normalizePublicReadMarkerIds(payload.markerIds);
  const request = (markerId: string) =>
    fetchSingleMarker(
      PUBLIC_READ_COMMENTS_PATH,
      buildPublicCommentsSearchParams({
        markerIds: [markerId],
        limit: PUBLIC_MARKER_COMMENT_CACHE_LIMIT,
        replyLimit: PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT,
        cacheNamespace: payload.cacheNamespace,
      }),
    );
  const selectComments = (comments: PublicSubmissionComment[]) =>
    comments.slice(0, payload.limit).map((comment) => ({
      ...comment,
      replies: comment.replies.slice(0, payload.replyLimit),
    }));
  const markerItems =
    markerIds.length === 1
      ? await readSingleItem<PublicSubmissionComment>(
          () => request(markerIds[0]!),
          "comment",
          selectComments,
        )
      : await readItems<PublicSubmissionComment>(markerIds, request, "comment", selectComments);
  if (markerItems instanceof Response) {
    return markerItems;
  }

  const items = markerItems.items.flat();
  return combinedResult(
    items,
    items.length > 0 ? "public, max-age=15" : "public, max-age=5",
    "x-oem-marker-comment-kv-cache",
    markerItems.failedCount,
    markerItems.failedMarkerIds,
  );
}

export async function fetchProgressStatsFromWorkersCache(
  markerIndexHash: string,
): Promise<Response> {
  const searchParams = buildProgressStatsSearchParams(markerIndexHash);
  const { request, cacheKey } = createPublicReadRequest(
    PUBLIC_READ_PROGRESS_STATS_PATH,
    searchParams,
  );
  return fetchPublicRead(request, cacheKey);
}

export async function purgePublicMarkerResponseCache(
  kind: PublicReadMarkerKind,
  markerId: string,
): Promise<void> {
  try {
    const result = await workerExports.PublicReadCache.purgeMarker(kind, markerId);
    if (!result.success) {
      console.warn("Workers Cache marker purge failed", {
        kind,
        markerTag: await buildPublicReadMarkerTag(kind, markerId),
        errors: result.errors,
      });
    }
  } catch (error) {
    console.warn("Workers Cache marker purge failed", {
      kind,
      markerTag: await buildPublicReadMarkerTag(kind, markerId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type { PublicMarkerListResponse } from "../contract/markers";
