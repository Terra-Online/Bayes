import { sha256Hex } from "./kvJson";
import { CACHE_KEY_VERSIONS } from "./versions";

export type PublicReadCacheNamespace = "default" | "test" | "prod";
export type PublicReadMarkerKind = "comment" | "image";

export const PUBLIC_READ_CACHE_ORIGIN = "https://public-read-cache.internal";
export const PUBLIC_READ_IMAGES_PATH = "/images";
export const PUBLIC_READ_COMMENTS_PATH = "/comments";
export const PUBLIC_READ_PROGRESS_STATS_PATH = "/progress-stats";

export function normalizePublicReadMarkerIds(markerIds: string[]): string[] {
  return [...new Set(markerIds.map((markerId) => markerId.trim()).filter(Boolean))].sort();
}

export function buildPublicReadCacheKey(path: string, searchParams: URLSearchParams): string {
  const search = searchParams.toString();
  const versionedPath = `/${CACHE_KEY_VERSIONS.publicReadResponses}${path}`;
  return search ? `${versionedPath}?${search}` : versionedPath;
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

export async function buildPublicReadMarkerTag(
  kind: PublicReadMarkerKind,
  markerId: string
): Promise<string> {
  return `ugc-${kind}:${await sha256Hex(markerId)}`;
}

export function resolveScopeFromPublicReadNamespace(namespace: PublicReadCacheNamespace): {
  pathPrefix?: string;
  excludePathPrefix?: string;
} {
  if (namespace === "test") {
    return { pathPrefix: "_test" };
  }
  if (namespace === "prod") {
    return { excludePathPrefix: "_test" };
  }
  return {};
}

export function parsePublicReadNamespace(value: string | null): PublicReadCacheNamespace | null {
  return value === "default" || value === "test" || value === "prod" ? value : null;
}
