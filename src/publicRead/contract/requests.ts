import type { PublicReadCacheNamespace } from "./markers";

export const PUBLIC_READ_CACHE_ORIGIN = "https://public-read-cache.internal";
export const PUBLIC_READ_IMAGES_PATH = "/images";
export const PUBLIC_READ_COMMENTS_PATH = "/comments";
export const PUBLIC_READ_PROGRESS_STATS_PATH = "/progress-stats";

export function normalizePublicReadMarkerIds(markerIds: string[]): string[] {
  return [...new Set(markerIds.map((markerId) => markerId.trim()).filter(Boolean))].sort();
}

export function buildPublicImagesSearchParams(payload: {
  markerIds: string[];
  limit: number;
  cacheNamespace: PublicReadCacheNamespace;
  assetBaseUrl: string;
}): URLSearchParams {
  const searchParams = new URLSearchParams();
  normalizePublicReadMarkerIds(payload.markerIds)
    .forEach((markerId) => searchParams.append("markerId", markerId));
  searchParams.set("limit", String(payload.limit));
  searchParams.set("namespace", payload.cacheNamespace);
  searchParams.set("assetBaseUrl", payload.assetBaseUrl);
  return searchParams;
}

export function buildPublicCommentsSearchParams(payload: {
  markerIds: string[];
  limit: number;
  replyLimit: number;
  cacheNamespace: PublicReadCacheNamespace;
}): URLSearchParams {
  const searchParams = new URLSearchParams();
  normalizePublicReadMarkerIds(payload.markerIds)
    .forEach((markerId) => searchParams.append("markerId", markerId));
  searchParams.set("limit", String(payload.limit));
  searchParams.set("replyLimit", String(payload.replyLimit));
  searchParams.set("namespace", payload.cacheNamespace);
  return searchParams;
}

export function buildProgressStatsSearchParams(markerIndexHash: string): URLSearchParams {
  return new URLSearchParams({ markerIndexHash: markerIndexHash.trim().toLowerCase() });
}

export function parsePublicReadInteger(value: string | null, minimum: number, maximum: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}
