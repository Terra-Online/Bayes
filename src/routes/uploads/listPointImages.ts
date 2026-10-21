import type { Context } from "hono";

import { getUgcReadConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { toApiError } from "@/middleware/error-handler";
import { readPublicImagesFromWorkersCache } from "@/publicRead/client/client";
import { resolvePublicImageCacheNamespace } from "@/publicRead/client/scope";
import {
  listImageViewerReactionsByMarker,
  listUserImagesByMarker,
} from "@/repositories/submission/listImages";
import { imagesQuerySchema } from "@/routes/schema/uploads";
import { applyImageViewerReactions } from "@/services/upload/viewerOverlay";
import type { AppEnv, AuthUser } from "@/types/app";

import { requireMarkerIds } from "./helpers";
import { resolveImageScope, resolvePrivateAssetBaseUrl, resolvePublicAssetBaseUrl } from "./scope";

// Both sections share authentication, but keep independent failure semantics.
// Only the public section's source data crosses the public-cache boundary.
export async function handleListPointImages<
  E extends AppEnv<{ authUser?: AuthUser; requestId: string }>,
>(c: Context<E>) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  const parsed = imagesQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.");
  }
  const markerIds = requireMarkerIds(parsed.data);
  const config = getUgcReadConfig(c.env);
  const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
  const assetBaseUrl = resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl);
  const limit = parsed.data.limit ?? 6;

  const [images, mine] = await Promise.allSettled([
    (async () => {
      const result = await readPublicImagesFromWorkersCache({
        markerIds,
        limit,
        assetBaseUrl,
        cacheNamespace: resolvePublicImageCacheNamespace(scope),
      });
      if (result instanceof Response) {
        throw new ApiError(503, "PUBLIC_CACHE_READ_FAILED", "Public images could not be read.");
      }
      const reactions = await listImageViewerReactionsByMarker(c.env.DB, {
        userId: user.uid,
        markerIds,
        submissionIds: result.payload.items.map((item) => item.id),
        ...scope,
      });
      return {
        ...result.payload,
        items: applyImageViewerReactions(result.payload.items, reactions),
      };
    })(),
    listUserImagesByMarker(c.env.DB, {
      userId: user.uid,
      markerIds,
      assetBaseUrl,
      privateAssetBaseUrl: resolvePrivateAssetBaseUrl(c.req.url),
      limit,
      ...scope,
    }).then((items) => ({ items })),
  ]);

  function section<T>(name: string, result: PromiseSettledResult<T>) {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const error = toApiError(result.reason);
    console.error("[point-images] section failed", {
      section: name,
      code: error.code,
      requestId: c.get("requestId"),
    });
    return { error: { code: error.code, status: error.status, message: error.message } };
  }
  const partial =
    images.status === "rejected" ||
    mine.status === "rejected" ||
    (images.status === "fulfilled" && images.value.partial === true);
  c.header("Cache-Control", "private, no-store");
  if (partial) {
    c.header("x-oem-partial-response", "true");
  }
  return c.json(
    { images: section("images", images), mine: section("mine", mine) },
    partial ? 207 : 200,
  );
}
