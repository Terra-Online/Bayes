import { Hono } from "hono";

import { getRuntimeConfig, getUgcReadConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { readPublicImagesFromWorkersCache } from "@/publicRead/client/client";
import { resolvePublicImageCacheNamespace } from "@/publicRead/client/scope";
import { getPublicImageById } from "@/repositories/submission/getPublicImage";
import { listUserImagesByMarker } from "@/repositories/submission/listImages";
import { imageQuerySchema, imagesQuerySchema } from "@/routes/schema/uploads";
import { readImageViewerFeed } from "@/services/ugc/read/feeds";
import { readImageSections } from "@/services/ugc/read/imageSections";
import type { AppEnv } from "@/types/app";

import { getOptionalAuthIdentity, hasAuthHeaders, requireMarkerIds } from "./helpers";
import { imageListRateLimit, parseImageListAccess, requireActiveUser } from "./middleware";
import { imageSectionsResponse, publicReadResponse, viewerReadResponse } from "./responses";
import { resolveImageScope, resolvePrivateAssetBaseUrl, resolvePublicAssetBaseUrl } from "./scope";

export function createRoutes() {
  return (
    new Hono<AppEnv<{ requestId: string }>>()
      .get("/images/mine", requireActiveUser, rateLimit("auth"), async (c) => {
        const user = c.get("authUser");

        const parsed = imagesQuerySchema.safeParse({
          markerId: c.req.query("markerId"),
          markerIds: c.req.query("markerIds"),
          scope: c.req.query("scope"),
          limit: c.req.query("limit"),
          publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
        });
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid image query.",
            parsed.error.flatten(),
          );
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
      })
      // Keep after /images/mine so "mine" is not treated as an image ID.
      .get("/images/:id", rateLimit("public"), async (c) => {
        const parsed = imageQuerySchema.safeParse({
          markerId: c.req.query("markerId"),
          scope: c.req.query("scope"),
        });
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid image query.",
            parsed.error.flatten(),
          );
        }

        const config = getRuntimeConfig(c.env);
        const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
        const identity = await getOptionalAuthIdentity(c.env, c.req.raw.headers);
        const item = await getPublicImageById(c.env.DB, {
          id: c.req.param("id"),
          markerId: parsed.data.markerId,
          assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
          ...scope,
          viewerUserId: identity?.uid,
        });
        if (!item) {
          throw new ApiError(404, "NOT_FOUND", "Image not found.");
        }
        const response = c.json({ item });
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      })
      .get("/images", parseImageListAccess, imageListRateLimit, async (c) => {
        const access = c.get("imageListAccess");
        if (access.kind === "includeMine") {
          const parsed = imagesQuerySchema.safeParse(c.req.query());
          if (!parsed.success) {
            throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.");
          }
          const markerIds = requireMarkerIds(parsed.data);
          const config = getUgcReadConfig(c.env);
          const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
          const assetBaseUrl = resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl);
          const limit = parsed.data.limit ?? 6;

          const result = await readImageSections(c.env, {
            viewerUserId: access.user.uid,
            markerIds,
            limit,
            scope,
            assetBaseUrl,
            privateAssetBaseUrl: resolvePrivateAssetBaseUrl(c.req.url),
          });
          return imageSectionsResponse(result, c.get("requestId"));
        }

        const parsed = imagesQuerySchema.safeParse({
          markerId: c.req.query("markerId"),
          markerIds: c.req.query("markerIds"),
          scope: c.req.query("scope"),
          limit: c.req.query("limit"),
          publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
        });
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid image query.",
            parsed.error.flatten(),
          );
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
        if (!identity || !publicResponse.ok) {
          return publicReadResponse(publicResponse);
        }

        const { payload } = publicResponse;
        const images = await readImageViewerFeed(c.env.DB, {
          viewerUserId: identity.uid,
          markerIds: ids,
          publicImages: payload.items,
          scope,
        });

        return viewerReadResponse(publicResponse, images);
      })
  );
}
