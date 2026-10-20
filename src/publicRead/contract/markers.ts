export type PublicReadCacheNamespace = "default" | "test" | "prod";
export type PublicReadMarkerKind = "comment" | "image";
export type PublicImageCacheNamespace = PublicReadCacheNamespace;
export type PublicCommentCacheNamespace = PublicReadCacheNamespace;

export const PUBLIC_MARKER_IMAGE_CACHE_LIMIT = 24;
export const PUBLIC_MARKER_COMMENT_CACHE_LIMIT = 50;
export const PUBLIC_MARKER_COMMENT_REPLY_CACHE_LIMIT = 5;

export type PublicMarkerListResponse<T> = {
  items: T[];
  partial?: boolean;
};

export function resolvePublicImageCacheNamespace(scope: {
  pathPrefix?: string;
  excludePathPrefix?: string;
}): PublicImageCacheNamespace {
  if (scope.pathPrefix === "_test") {
    return "test";
  }
  if (scope.excludePathPrefix === "_test") {
    return "prod";
  }
  return "default";
}

export function resolvePublicCommentCacheNamespace(scope: {
  pathPrefix?: string;
  excludePathPrefix?: string;
}): PublicCommentCacheNamespace {
  if (scope.pathPrefix === "_test") {
    return "test";
  }
  if (scope.excludePathPrefix === "_test") {
    return "prod";
  }
  return "default";
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
