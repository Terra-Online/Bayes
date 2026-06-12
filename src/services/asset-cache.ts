export const UGC_PUBLIC_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const UGC_PUBLIC_LIST_CACHE_CONTROL = "public, max-age=30";
export const UGC_PUBLIC_EMPTY_LIST_CACHE_CONTROL = "public, max-age=10";

export function buildPublicUgcAssetUrl(assetBaseUrl: string, filePath: string): string {
  return `${assetBaseUrl.replace(/\/$/, "")}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

export async function prewarmPublicUgcAsset(assetBaseUrl: string, filePath: string | null): Promise<void> {
  if (!filePath) {
    return;
  }

  let response: Response;
  try {
    response = await fetch(buildPublicUgcAssetUrl(assetBaseUrl, filePath), {
      method: "GET",
      cf: {
        cacheTtl: 31536000,
        cacheEverything: true
      }
    });
  } catch (error) {
    console.warn("UGC public asset prewarm failed", {
      filePath,
      error: error instanceof Error ? error.message : "unknown"
    });
    return;
  }

  if (!response.ok) {
    console.warn("UGC public asset prewarm failed", {
      filePath,
      status: response.status
    });
  }
}
