import type { Context } from "hono";

import { getUgcReadConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { readPublicImagesFromWorkersCache, publicReadResponse } from "@/publicRead/client/client";
import { resolvePublicImageCacheNamespace } from "@/publicRead/client/scope";
import {
  listImageViewerReactionsByMarker,
  listUserImagesByMarker,
} from "@/repositories/submission/listImages";
import { imagesQuerySchema } from "@/routes/schema/uploads";
import { applyImageViewerReactions } from "@/services/upload/viewerOverlay";
import type { AppEnv, AuthUser } from "@/types/app";

import { getOptionalAuthIdentity, hasAuthHeaders, requireMarkerIds } from "./helpers";
import { resolveImageScope, resolvePrivateAssetBaseUrl, resolvePublicAssetBaseUrl } from "./scope";

export async function handleListMyImages<E extends AppEnv<{ authUser: AuthUser }>>(c: Context<E>) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }

  const parsed = imagesQuerySchema.safeParse({
    markerId: c.req.query("markerId"),
    markerIds: c.req.query("markerIds"),
    scope: c.req.query("scope"),
    limit: c.req.query("limit"),
    publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
  }

  const ids = requireMarkerIds(parsed.data, false);
  const config = getUgcReadConfig(c.env);
  const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
  const items = await listUserImagesByMarker(c.env.DB, {
    userId: user.uid,
    markerIds: ids,
    assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
    privateAssetBaseUrl: resolvePrivateAssetBaseUrl(c.req.url),
    pathPrefix: scope.pathPrefix,
    excludePathPrefix: scope.excludePathPrefix,
    limit: parsed.data.limit ?? 6,
  });

  const response = c.json({ items });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function handleListPublicImages<E extends AppEnv>(c: Context<E>) {
  const parsed = imagesQuerySchema.safeParse({
    markerId: c.req.query("markerId"),
    markerIds: c.req.query("markerIds"),
    scope: c.req.query("scope"),
    limit: c.req.query("limit"),
    publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
  }

  const ids = requireMarkerIds(parsed.data);
  const config = getUgcReadConfig(c.env);
  const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
  const limit = parsed.data.limit ?? 6;
  const assetBaseUrl = resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl);
  const publicResponsePromise = readPublicImagesFromWorkersCache({
    markerIds: ids,
    limit,
    cacheNamespace: resolvePublicImageCacheNamespace(scope),
    assetBaseUrl,
  });

  if (parsed.data.publicOnly === "1" || !hasAuthHeaders(c.req.raw.headers)) {
    return publicReadResponse(await publicResponsePromise);
  }

  const [publicResponse, identity] = await Promise.all([
    publicResponsePromise,
    getOptionalAuthIdentity(c.env, c.req.raw.headers),
  ]);
  if (!identity || publicResponse instanceof Response) {
    return publicReadResponse(publicResponse);
  }

  const { payload } = publicResponse;
  const reactions = await listImageViewerReactionsByMarker(c.env.DB, {
    userId: identity.uid,
    markerIds: ids,
    submissionIds: payload.items.map((image) => image.id),
    pathPrefix: scope.pathPrefix,
    excludePathPrefix: scope.excludePathPrefix,
  });
  const images = applyImageViewerReactions(payload.items, reactions);

  const response = c.json({ ...payload, items: images });
  for (const header of ["x-oem-partial-response", "x-oem-failed-marker-count"]) {
    const value = publicResponse.headers[header];
    if (value !== undefined) {
      response.headers.set(header, value);
    }
  }
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("x-oem-viewer-overlay", "image");
  return response;
}
