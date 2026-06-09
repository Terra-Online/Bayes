import { getRandom } from "@cloudflare/containers";
import type { oem_imgTrans } from "./image-transcoder-container";

const IMAGE_TRANSFORM_CONTAINER_INSTANCES = 3;

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
}): Promise<PreparedUploadImage> {
  const container = await getRandom(payload.transcoder, IMAGE_TRANSFORM_CONTAINER_INSTANCES);
  const response = await container.fetch("http://oem-img-trans/prepare", {
    method: "POST",
    headers: {
      "Content-Type": payload.mimeType,
      "X-Source-Mime": payload.mimeType,
      "X-Source-Size-Bytes": String(payload.body.byteLength)
    },
    body: payload.body
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Image transformer failed with HTTP ${response.status}.`);
  }

  const body = await response.arrayBuffer();
  const mimeType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() || payload.mimeType;
  if (extensionFromMime(mimeType) === "bin") {
    throw new Error(`Image transformer returned unsupported MIME type: ${mimeType}`);
  }

  return {
    body,
    mimeType,
    sizeBytes: body.byteLength,
    converted: response.headers.get("X-Converted-To-Webp") === "true"
  };
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
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96) || "unknown";
}

function normalizePathPrefix(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}
