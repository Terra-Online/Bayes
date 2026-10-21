import { getRandom } from "@cloudflare/containers";

import { toSerializableError } from "@/lib/auth/errors";
import { ApiError, transientDependencyError } from "@/lib/errors";

import type { oem_imgTrans } from "./imageTranscoderContainer";

const IMAGE_TRANSFORM_CONTAINER_INSTANCES = 3;
const IMAGE_PREPARATION_TIMEOUT_MS = 60_000;

function isContainerDisconnected(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const cause = current as { message?: unknown; cause?: unknown };
    if (
      typeof cause.message === "string" &&
      /\bcontainer\b.*(?:not running|(?:just |suddenly )?disconnected)/i.test(cause.message)
    ) {
      return true;
    }
    current = cause.cause;
  }
  return false;
}

function unavailableImageService(): ApiError {
  return new ApiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Image processing is temporarily unavailable. Please try again later.",
  );
}

function imageDependencyError(error: unknown): ApiError {
  const dependency = transientDependencyError(error);
  let current = error;
  const messages: string[] = [];
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const cause = current as { message?: unknown; cause?: unknown };
    if (typeof cause.message === "string") {
      messages.push(cause.message);
    }
    current = cause.cause;
  }
  const capacityExceeded =
    /too many (?:containers|instances)|(?:container|instance).*(?:overloaded|rate limited|(?:capacity|resource limit).*(?:exhausted|exceeded))/i.test(
      messages.join(" "),
    );
  if (dependency?.code === "DEPENDENCY_OVERLOADED" || capacityExceeded) {
    return new ApiError(
      503,
      "DEPENDENCY_OVERLOADED",
      "Image processing is busy. Please try again later.",
    );
  }
  return dependency ?? unavailableImageService();
}

export interface PreparedUploadImage {
  body: ArrayBuffer;
  mimeType: string;
  sizeBytes: number;
  converted: boolean;
}

export function extensionFromMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "bin";
  }
}

export async function prepareUploadImageForStorage(payload: {
  body: ArrayBuffer;
  mimeType: string;
  transcoder: DurableObjectNamespace<oem_imgTrans>;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<PreparedUploadImage> {
  payload.signal?.throwIfAborted();
  if (payload.mimeType === "image/webp" || payload.mimeType === "image/avif") {
    return {
      body: payload.body,
      mimeType: payload.mimeType,
      sizeBytes: payload.body.byteLength,
      converted: false,
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort(payload.signal?.reason);
  payload.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(
    () => controller.abort(unavailableImageService()),
    IMAGE_PREPARATION_TIMEOUT_MS,
  );
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  const withinDeadline = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, aborted]);
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let stage = "container_lookup";
      let upstreamStatus: number | undefined;
      try {
        controller.signal.throwIfAborted();
        const container = await withinDeadline(
          getRandom(payload.transcoder, IMAGE_TRANSFORM_CONTAINER_INSTANCES),
        );
        stage = "container_fetch";
        // Each attempt gets a fresh request and stub; no storage writes happen here.
        const request = new Request("http://oem-img-trans/prepare", {
          method: "POST",
          headers: {
            "Content-Type": payload.mimeType,
            "X-Source-Mime": payload.mimeType,
            "X-Source-Size-Bytes": String(payload.body.byteLength),
          },
          body: payload.body,
          signal: controller.signal,
        });
        const response = await withinDeadline(container.fetch(request));
        upstreamStatus = response.status;
        stage = "container_response";
        if (!response.ok) {
          const detail = await withinDeadline(response.text());
          const transportError = new Error(
            detail || `Image transformer failed with HTTP ${response.status}.`,
          );
          const overloaded =
            response.status === 429 ||
            imageDependencyError(transportError).code === "DEPENDENCY_OVERLOADED";
          if (overloaded) {
            throw new ApiError(
              503,
              "DEPENDENCY_OVERLOADED",
              "Image processing is busy. Please try again later.",
            );
          }
          if ([400, 413, 415, 422].includes(response.status)) {
            throw new ApiError(422, "IMAGE_PROCESSING_FAILED", "Image could not be processed.");
          }
          throw transportError;
        }

        const mimeType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
        if (!mimeType || extensionFromMime(mimeType) === "bin") {
          if (response.body) {
            await withinDeadline(response.body.cancel());
          }
          throw new ApiError(
            502,
            "IMAGE_PROCESSING_BAD_RESPONSE",
            "Image processor returned an invalid response.",
          );
        }
        stage = "container_body";
        const body = await withinDeadline(response.arrayBuffer());
        controller.signal.throwIfAborted();
        if (body.byteLength === 0) {
          throw new ApiError(
            502,
            "IMAGE_PROCESSING_BAD_RESPONSE",
            "Image processor returned an empty image.",
          );
        }
        return {
          body,
          mimeType,
          sizeBytes: body.byteLength,
          converted: response.headers.get("X-Converted-To-Webp") === "true",
        };
      } catch (error) {
        if (payload.signal?.aborted) {
          throw payload.signal.reason;
        }
        const apiError = error instanceof ApiError ? error : imageDependencyError(error);
        const retry =
          attempt === 1 &&
          !controller.signal.aborted &&
          apiError.code === "DEPENDENCY_UNAVAILABLE" &&
          isContainerDisconnected(error);
        console.warn("image preparation failed", {
          requestId: payload.requestId,
          stage,
          attempt,
          elapsedMs: Date.now() - startedAt,
          upstreamStatus,
          code: apiError.code,
          retry,
          error: toSerializableError(error),
        });
        if (!retry) {
          throw apiError;
        }
        await withinDeadline(new Promise<void>((resolve) => setTimeout(resolve, 250)));
      }
    }
    throw unavailableImageService();
  } finally {
    clearTimeout(timeout);
    payload.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}

export function buildUploadObjectKey(payload: {
  poiType: string;
  poiHash: string;
  snapshotId: string;
  mimeType: string;
  prefix?: string;
}): string {
  const ext = extensionFromMime(payload.mimeType);
  const baseKey = `poi/${payload.poiType}/${payload.poiHash}/${payload.snapshotId}.${ext}`;
  const prefix = normalizePathPrefix(payload.prefix);
  return prefix ? `${prefix}/${baseKey}` : baseKey;
}

export function normalizePathPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 96) || "unknown"
  );
}

function normalizePathPrefix(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}
