import { ApiError } from "../../lib/errors";

export function pickString(value: FormDataEntryValue | FormDataEntryValue[] | undefined): string | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  return typeof item === "string" ? item : undefined;
}

export function pickFile(value: FormDataEntryValue | FormDataEntryValue[] | undefined): File | null {
  const item = Array.isArray(value) ? value[0] : value;
  return item instanceof File ? item : null;
}

function mimeFromFilename(filename: string): string {
  const ext = filename.trim().toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    default:
      return "";
  }
}

export function normalizeUploadMime(file: File): string {
  const mimeType = file.type.trim().toLowerCase();
  if (mimeType && mimeType !== "application/octet-stream") {
    return mimeType;
  }
  return mimeFromFilename(file.name);
}

export function parseMarkerIds(payload: { markerId?: string; markerIds?: string }, unique = true): string[] {
  const markerIds = payload.markerIds
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const ids = markerIds?.length ? markerIds : payload.markerId ? [payload.markerId] : [];
  return unique ? [...new Set(ids)].slice(0, 100) : ids;
}

export function requireMarkerIds(payload: { markerId?: string; markerIds?: string }, unique = true): string[] {
  const ids = parseMarkerIds(payload, unique);
  if (ids.length === 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "markerId or markerIds is required.");
  }
  return ids;
}

export function hasAuthHeaders(headers: Headers): boolean {
  return Boolean(
    headers.get("authorization")?.trim() ||
    headers.get("cookie")?.trim()
  );
}

function parseObjectKey(raw: string | undefined): string {
  const key = raw?.trim() ?? "";
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\")) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
  }
  return key;
}

export function parseObjectKeyFromRequestPath(path: string): string {
  const publicMarker = "/uploads/v1/public-file/";
  const localPublicMarker = "/public-file/";
  const publicMarkerIndex = path.indexOf(publicMarker);
  if (publicMarkerIndex >= 0) {
    try {
      return parseObjectKey(decodeURIComponent(path.slice(publicMarkerIndex + publicMarker.length)));
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
    }
  }
  if (path.startsWith(localPublicMarker)) {
    try {
      return parseObjectKey(decodeURIComponent(path.slice(localPublicMarker.length)));
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
    }
  }

  const marker = "/uploads/v1/file/";
  const localMarker = "/file/";
  const markerIndex = path.indexOf(marker);
  const raw = markerIndex >= 0
    ? path.slice(markerIndex + marker.length)
    : path.startsWith(localMarker)
      ? path.slice(localMarker.length)
      : "";

  try {
    return parseObjectKey(decodeURIComponent(raw));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
  }
}
