import decodeAvif, { init as initAvifDecode } from "@jsquash/avif/decode.js";
import avifDecodeWasm from "@jsquash/avif/codec/dec/avif_dec.wasm?module";
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import jpegDecodeWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?module";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode.js";
import pngDecodeWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm?module";
import resize, { initResize } from "@jsquash/resize";
import resizeWasm from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm?module";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import webpDecodeWasm from "@jsquash/webp/codec/dec/webp_dec.wasm?module";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";
import webpEncodeWasm from "@jsquash/webp/codec/enc/webp_enc.wasm?module";
import webpEncodeSimdWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?module";
import { simd } from "wasm-feature-detect";
import type { ImageDimensions } from "./image-metadata";

const WORKER_WEBP_CONVERSION_MIN_BYTES = 4 * 1024 * 1024;
const WORKER_WEBP_CONVERSION_MIN_EDGE = 2160;
const WORKER_WEBP_RESIZE_EDGE = 2560;
const WEBP_QUALITY = 80;

let codecReady: Promise<void> | null = null;

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
    default:
      return "bin";
  }
}

export async function prepareUploadImageForStorage(payload: {
  body: ArrayBuffer;
  mimeType: string;
  dimensions: ImageDimensions | null;
}): Promise<PreparedUploadImage> {
  let dimensions = payload.dimensions;
  let decoded: ImageData | null = null;
  if (!dimensions) {
    await initCodecs();
    decoded = await decodeImage(payload.body, payload.mimeType);
    dimensions = {
      width: decoded.width,
      height: decoded.height
    };
  }

  const edge = longestEdge(dimensions);
  const shouldConvert = payload.body.byteLength >= WORKER_WEBP_CONVERSION_MIN_BYTES
    || edge >= WORKER_WEBP_CONVERSION_MIN_EDGE;

  if (!shouldConvert) {
    return {
      body: payload.body,
      mimeType: payload.mimeType,
      sizeBytes: payload.body.byteLength,
      converted: false
    };
  }

  await initCodecs();
  decoded ??= await decodeImage(payload.body, payload.mimeType);
  const nextImage = await resizeToMaxEdge(decoded, WORKER_WEBP_RESIZE_EDGE);
  const body = await encodeWebp(nextImage, { quality: WEBP_QUALITY });

  return {
    body,
    mimeType: "image/webp",
    sizeBytes: body.byteLength,
    converted: true
  };
}

async function initCodecs(): Promise<void> {
  codecReady ??= (async () => {
    await Promise.all([
      initAvifDecode(avifDecodeWasm),
      initJpegDecode(jpegDecodeWasm),
      initPngDecode(pngDecodeWasm),
      initResize(resizeWasm),
      initWebpDecode(webpDecodeWasm),
      initWebpEncode(await simd() ? webpEncodeSimdWasm : webpEncodeWasm)
    ]);
  })();
  await codecReady;
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

async function decodeImage(body: ArrayBuffer, mimeType: string): Promise<ImageData> {
  switch (mimeType) {
    case "image/jpeg":
      return decodeJpeg(body);
    case "image/png":
      return decodePng(body);
    case "image/webp":
      return decodeWebp(body);
    case "image/avif": {
      const decoded = await decodeAvif(body);
      if (!decoded) {
        throw new Error("AVIF decode failed.");
      }
      return decoded;
    }
    default:
      throw new Error(`Unsupported image MIME type: ${mimeType}`);
  }
}

async function resizeToMaxEdge(image: ImageData, maxEdge: number): Promise<ImageData> {
  const edge = Math.max(image.width, image.height);
  if (edge <= maxEdge) {
    return image;
  }

  const scale = maxEdge / edge;
  return resize(image, {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale))
  });
}

function longestEdge(dimensions: ImageDimensions | null): number {
  return dimensions ? Math.max(dimensions.width, dimensions.height) : 0;
}
