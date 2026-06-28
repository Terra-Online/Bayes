import { deletePublicMarkerCommentCache } from "./publicMarkerComments";
import { deletePublicMarkerImageCache } from "./publicMarkerImages";

export type UploadCacheKind = "comment" | "image";

export async function invalidateUploadCaches(payload: {
  kv: KVNamespace | undefined;
  kind: UploadCacheKind;
  markerId: string;
}): Promise<void> {
  if (payload.kind === "comment") {
    await deletePublicMarkerCommentCache(payload.kv, payload.markerId);
    return;
  }

  await deletePublicMarkerImageCache(payload.kv, payload.markerId);
}

export async function readResponseFromCache(cacheName: string, key: Request): Promise<Response | null> {
  const cache = await caches.open(cacheName);
  return await cache.match(key) ?? null;
}

export async function writeResponseToCache(cacheName: string, key: Request, response: Response): Promise<void> {
  const cache = await caches.open(cacheName);
  await cache.put(key, response);
}
