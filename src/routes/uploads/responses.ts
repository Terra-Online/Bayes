import { toApiError } from "@/middleware/error-handler";
import {
  PUBLIC_EMPTY_IMAGE_LIST_CACHE_CONTROL,
  PUBLIC_IMAGE_LIST_CACHE_CONTROL,
  type PublicReadResult,
  type PublicReadSuccess,
} from "@/publicRead/client/client";
import type { ImageSectionResult, ImageSectionsResult } from "@/services/ugc/read/imageSections";

function partialReadHeaders<T>(result: PublicReadSuccess<T>): Record<string, string> {
  return result.payload.partial
    ? {
        "x-oem-partial-response": "true",
        "x-oem-failed-marker-count": String(result.payload.failedMarkerIds.length),
      }
    : {};
}

export function publicReadResponse<T>(result: PublicReadResult<T>): Response {
  if (!result.ok) {
    const { code, message, status } = result.error;
    return new Response(JSON.stringify({ code, message }), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        ...(status === 503 ? { "retry-after": "5" } : {}),
      },
    });
  }
  const hasItems = result.payload.items.length > 0;
  let cacheControl = "private, no-store";
  if (!result.payload.partial) {
    if (result.kind === "image") {
      cacheControl = hasItems
        ? PUBLIC_IMAGE_LIST_CACHE_CONTROL
        : PUBLIC_EMPTY_IMAGE_LIST_CACHE_CONTROL;
    } else {
      cacheControl = hasItems ? "public, max-age=15" : "public, max-age=5";
    }
  }
  return Response.json(result.payload, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      [result.kind === "image" ? "x-oem-marker-kv-cache" : "x-oem-marker-comment-kv-cache"]:
        "enabled",
      "x-oem-workers-cache": "per-marker",
      ...partialReadHeaders(result),
    },
  });
}

export function viewerReadResponse<T>(result: PublicReadSuccess<T>, items: T[]): Response {
  return Response.json(
    { ...result.payload, items },
    {
      headers: {
        ...partialReadHeaders(result),
        "Cache-Control": "private, no-store",
        "x-oem-viewer-overlay": result.kind,
      },
    },
  );
}

export function imageSectionsResponse(result: ImageSectionsResult, requestId?: string): Response {
  function section<T>(name: string, part: ImageSectionResult<T>) {
    if (part.ok) {
      return part.value;
    }
    const error = toApiError(part.error);
    console.error("[point-images] section failed", { section: name, code: error.code, requestId });
    return { error: { code: error.code, status: error.status, message: error.message } };
  }
  return Response.json(
    { images: section("images", result.images), mine: section("mine", result.mine) },
    {
      status: result.partial ? 207 : 200,
      headers: {
        "Cache-Control": "private, no-store",
        ...(result.partial ? { "x-oem-partial-response": "true" } : {}),
      },
    },
  );
}
