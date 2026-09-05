import { WorkerEntrypoint } from "cloudflare:workers";
import { toApiError } from "../error-handler";
import { isSha256Hex } from "../../services/progress/manifest";
import { buildPublicProgressStatsResponse } from "../../services/progress/publicStats";
import { listCachedPublicCommentsByMarker } from "../../services/upload/listPublicComments";
import { listCachedPublicImagesByMarker } from "../../services/upload/listPublicImages";
import type { Bindings } from "../../types/app";
import {
  PUBLIC_MARKER_COMMENT_EMPTY_TTL_SECONDS,
  PUBLIC_MARKER_COMMENT_POSITIVE_TTL_SECONDS
} from "./publicMarkerComments";
import {
  PUBLIC_MARKER_IMAGE_EMPTY_TTL_SECONDS,
  PUBLIC_MARKER_IMAGE_POSITIVE_TTL_SECONDS
} from "./publicMarkerImages";
import {
  buildPublicReadMarkerTag,
  normalizePublicReadMarkerIds,
  parsePublicReadNamespace,
  PUBLIC_READ_COMMENTS_PATH,
  PUBLIC_READ_IMAGES_PATH,
  PUBLIC_READ_PROGRESS_STATS_PATH,
  resolveScopeFromPublicReadNamespace,
  type PublicReadMarkerKind
} from "./publicReadKeys";
import {
  UGC_PUBLIC_EMPTY_LIST_CACHE_CONTROL,
  UGC_PUBLIC_LIST_CACHE_CONTROL
} from "./publicUgcAssets";

function noStoreError(status: number, message: string): Response {
  return new Response(JSON.stringify({ code: "INVALID_PUBLIC_CACHE_REQUEST", message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store"
    }
  });
}

function parseInteger(value: string | null, minimum: number, maximum: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

async function buildMarkerTags(kind: PublicReadMarkerKind, markerIds: string[]): Promise<string> {
  return (await Promise.all(markerIds.map((markerId) => buildPublicReadMarkerTag(kind, markerId)))).join(",");
}

export class PublicReadCache extends WorkerEntrypoint<Bindings> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return noStoreError(405, "Only GET and HEAD are supported.");
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === PUBLIC_READ_IMAGES_PATH) {
        return await this.fetchImages(url);
      }
      if (url.pathname === PUBLIC_READ_COMMENTS_PATH) {
        return await this.fetchComments(url);
      }
      if (url.pathname === PUBLIC_READ_PROGRESS_STATS_PATH) {
        return await this.fetchProgressStats(url);
      }
    } catch (error) {
      const apiError = toApiError(error);
      console.error("[public-read] cache origin read failed", {
        path: url.pathname,
        code: apiError.code,
        error: error instanceof Error ? error.message : String(error)
      });
      return Response.json({ code: apiError.code, message: apiError.message }, {
        status: apiError.status,
        headers: {
          "cache-control": "private, no-store",
          ...(apiError.status === 503 ? { "retry-after": "5" } : {})
        }
      });
    }
    return noStoreError(404, "Unknown public cache resource.");
  }

  async purgeMarker(kind: PublicReadMarkerKind, markerId: string): Promise<CachePurgeResult> {
    if ((kind !== "comment" && kind !== "image") || !markerId.trim()) {
      return {
        success: false,
        errors: [{ code: 400, message: "Invalid marker cache purge request." }]
      };
    }
    if (!this.ctx.cache) {
      return { success: true, errors: [] };
    }
    return this.ctx.cache.purge({
      tags: [await buildPublicReadMarkerTag(kind, markerId)]
    });
  }

  private async fetchImages(url: URL): Promise<Response> {
    const markerIds = normalizePublicReadMarkerIds(url.searchParams.getAll("markerId")).slice(0, 100);
    const limit = parseInteger(url.searchParams.get("limit"), 1, 24);
    const namespace = parsePublicReadNamespace(url.searchParams.get("namespace"));
    const assetBaseUrl = url.searchParams.get("assetBaseUrl")?.trim();
    if (markerIds.length === 0 || limit === null || !namespace || !assetBaseUrl) {
      return noStoreError(422, "Invalid public image cache request.");
    }

    const scope = resolveScopeFromPublicReadNamespace(namespace);
    const items = await listCachedPublicImagesByMarker({
      db: this.env.DB,
      kv: this.env.OEM_KV,
      markerIds,
      assetBaseUrl,
      pathPrefix: scope.pathPrefix,
      excludePathPrefix: scope.excludePathPrefix,
      limit,
      cacheNamespace: namespace,
      waitUntil: (promise) => this.ctx.waitUntil(promise)
    });

    return new Response(JSON.stringify({ items }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Cache-Control": items.length > 0
          ? UGC_PUBLIC_LIST_CACHE_CONTROL
          : UGC_PUBLIC_EMPTY_LIST_CACHE_CONTROL,
        "Cloudflare-CDN-Cache-Control": `public, max-age=${items.length > 0
          ? PUBLIC_MARKER_IMAGE_POSITIVE_TTL_SECONDS
          : PUBLIC_MARKER_IMAGE_EMPTY_TTL_SECONDS}`,
        "Cache-Tag": await buildMarkerTags("image", markerIds),
        "x-oem-marker-kv-cache": "enabled"
      }
    });
  }

  private async fetchComments(url: URL): Promise<Response> {
    const markerIds = normalizePublicReadMarkerIds(url.searchParams.getAll("markerId")).slice(0, 100);
    const limit = parseInteger(url.searchParams.get("limit"), 1, 50);
    const replyLimit = parseInteger(url.searchParams.get("replyLimit"), 0, 10);
    const namespace = parsePublicReadNamespace(url.searchParams.get("namespace"));
    if (markerIds.length === 0 || limit === null || replyLimit === null || !namespace) {
      return noStoreError(422, "Invalid public comment cache request.");
    }

    const items = await listCachedPublicCommentsByMarker({
      db: this.env.DB,
      kv: this.env.OEM_KV,
      markerIds,
      limit,
      replyLimit,
      cacheNamespace: namespace,
      waitUntil: (promise) => this.ctx.waitUntil(promise)
    });

    return new Response(JSON.stringify({ items }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Cache-Control": items.length > 0 ? "public, max-age=15" : "public, max-age=5",
        "Cloudflare-CDN-Cache-Control": `public, max-age=${items.length > 0
          ? PUBLIC_MARKER_COMMENT_POSITIVE_TTL_SECONDS
          : PUBLIC_MARKER_COMMENT_EMPTY_TTL_SECONDS}`,
        "Cache-Tag": await buildMarkerTags("comment", markerIds),
        "x-oem-marker-comment-kv-cache": "enabled"
      }
    });
  }

  private async fetchProgressStats(url: URL): Promise<Response> {
    const markerIndexHash = url.searchParams.get("markerIndexHash")?.trim().toLowerCase() ?? "";
    if (!isSha256Hex(markerIndexHash)) {
      return noStoreError(422, "Invalid progress stats cache request.");
    }
    return buildPublicProgressStatsResponse(this.env, markerIndexHash);
  }
}
