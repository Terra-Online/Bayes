import { ApiError } from "@/lib/errors";
import { readPublicImagesFromWorkersCache } from "@/publicRead/client/client";
import { resolvePublicImageCacheNamespace } from "@/publicRead/client/scope";
import { listUserImagesByMarker } from "@/repositories/submission/listImages";
import type { PublicSubmissionImage, UserSubmissionImage } from "@/repositories/submission/types";
import type { ImageReadScope } from "@/services/ugc/contract/imageScope";
import type { Bindings } from "@/types/app";

import { readImageViewerFeed } from "./feeds";

export type ImageSectionResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

type ImageList = { items: PublicSubmissionImage[]; partial?: boolean; failedMarkerIds?: string[] };

export interface ImageSectionsResult {
  images: ImageSectionResult<ImageList>;
  mine: ImageSectionResult<{ items: UserSubmissionImage[] }>;
  partial: boolean;
}

function sectionResult<T>(result: PromiseSettledResult<T>): ImageSectionResult<T> {
  return result.status === "fulfilled"
    ? { ok: true, value: result.value }
    : { ok: false, error: result.reason };
}

export async function readImageSections(
  bindings: Bindings,
  input: {
    viewerUserId: string;
    markerIds: string[];
    limit: number;
    scope: ImageReadScope;
    assetBaseUrl: string;
    privateAssetBaseUrl: string;
  },
): Promise<ImageSectionsResult> {
  // The two sections fail independently. Only the public source crosses the shared cache.
  const [images, mine] = await Promise.allSettled([
    (async () => {
      const result = await readPublicImagesFromWorkersCache({
        markerIds: input.markerIds,
        limit: input.limit,
        assetBaseUrl: input.assetBaseUrl,
        cacheNamespace: resolvePublicImageCacheNamespace(input.scope),
      });
      if (!result.ok) {
        throw new ApiError(503, "PUBLIC_CACHE_READ_FAILED", "Public images could not be read.");
      }
      const items = await readImageViewerFeed(bindings.DB, {
        viewerUserId: input.viewerUserId,
        markerIds: input.markerIds,
        publicImages: result.payload.items,
        scope: input.scope,
      });
      return { ...result.payload, items };
    })(),
    listUserImagesByMarker(bindings.DB, {
      userId: input.viewerUserId,
      markerIds: input.markerIds,
      assetBaseUrl: input.assetBaseUrl,
      privateAssetBaseUrl: input.privateAssetBaseUrl,
      limit: input.limit,
      ...input.scope,
    }).then((items) => ({ items })),
  ]);
  return {
    images: sectionResult(images),
    mine: sectionResult(mine),
    partial:
      images.status === "rejected" ||
      mine.status === "rejected" ||
      (images.status === "fulfilled" && images.value.partial === true),
  };
}
