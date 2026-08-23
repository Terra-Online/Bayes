import { buildPublicUgcAssetUrl } from "../../middleware/cache/publicUgcAssets";
import { listAllImageFilePaths } from "../../repositories/submission-review";

export type OrphanImageObject = {
  key: string;
  url: string;
  sizeBytes: number;
  uploadedAt: string;
  etag: string;
  contentType: string | null;
  sourceMimeType: string | null;
  convertedToWebp: boolean;
  storageClass: string;
};

export type OrphanImageReport = {
  generatedAt: string;
  items: OrphanImageObject[];
  stats: {
    r2ObjectCount: number;
    r2SizeBytes: number;
    referencedFileCount: number;
    orphanObjectCount: number;
    orphanSizeBytes: number;
  };
};

export async function getOrphanImages(payload: {
  db: D1Database;
  bucket: R2Bucket;
  assetBaseUrl: string;
}): Promise<OrphanImageReport> {
  const referencedPaths = new Set(await listAllImageFilePaths(payload.db));
  const items: OrphanImageObject[] = [];
  let cursor: string | undefined;
  let r2ObjectCount = 0;
  let r2SizeBytes = 0;

  do {
    const listed = await payload.bucket.list({
      cursor,
      limit: 1000
    });
    r2ObjectCount += listed.objects.length;

    for (const object of listed.objects) {
      r2SizeBytes += object.size;
      if (referencedPaths.has(object.key)) {
        continue;
      }
      const metadata = await payload.bucket.head(object.key);
      items.push({
        key: object.key,
        url: buildPublicUgcAssetUrl(payload.assetBaseUrl, object.key),
        sizeBytes: object.size,
        uploadedAt: object.uploaded.toISOString(),
        etag: object.etag,
        contentType: metadata?.httpMetadata?.contentType ?? null,
        sourceMimeType: metadata?.customMetadata?.sourceMimeType ?? null,
        convertedToWebp: metadata?.customMetadata?.convertedToWebp === "true",
        storageClass: object.storageClass
      });
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  items.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt) || left.key.localeCompare(right.key));

  return {
    generatedAt: new Date().toISOString(),
    items,
    stats: {
      r2ObjectCount,
      r2SizeBytes,
      referencedFileCount: referencedPaths.size,
      orphanObjectCount: items.length,
      orphanSizeBytes: items.reduce((total, item) => total + item.sizeBytes, 0)
    }
  };
}
