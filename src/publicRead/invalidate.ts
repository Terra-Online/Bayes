import { purgePublicMarkerResponseCache } from "./client/client";
import { deletePublicMarkerCommentCache } from "./origin/markerComments";
import { deletePublicMarkerImageCache } from "./origin/markerImages";

export type UploadCacheKind = "comment" | "image";

export async function invalidateUploadCaches(payload: {
  kv: KVNamespace | undefined;
  kind: UploadCacheKind;
  markerId: string;
}): Promise<void> {
  if (payload.kind === "comment") {
    await Promise.all([
      deletePublicMarkerCommentCache(payload.kv, payload.markerId),
      purgePublicMarkerResponseCache("comment", payload.markerId),
    ]);
    return;
  }

  await Promise.all([
    deletePublicMarkerImageCache(payload.kv, payload.markerId),
    purgePublicMarkerResponseCache("image", payload.markerId),
  ]);
}
