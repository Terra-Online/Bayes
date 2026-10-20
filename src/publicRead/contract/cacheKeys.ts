import { sha256Hex } from "../../lib/crypto";
import type { PublicReadMarkerKind } from "./markers";

export function buildPublicReadCacheKey(path: string, searchParams: URLSearchParams): string {
  const version = "v2";
  const search = searchParams.toString();
  const versionedPath = `/${version}${path}`;
  return search ? `${versionedPath}?${search}` : versionedPath;
}

export async function buildPublicReadMarkerTag(
  kind: PublicReadMarkerKind,
  markerId: string
): Promise<string> {
  return `ugc-${kind}:${await sha256Hex(markerId)}`;
}
