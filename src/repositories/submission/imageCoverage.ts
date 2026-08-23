import { buildImageScopeFilters } from "./listImages";

export type MarkerImageCount = {
  markerId: string;
  imageCount: number;
};

export async function listVisibleImageCountsByMarker(
  db: D1Database,
  payload: {
    pathPrefix?: string;
    excludePathPrefix?: string;
  }
): Promise<MarkerImageCount[]> {
  const filters = [
    "kind = 'image'",
    "status IN ('active', 'flagged', 'remove_request')"
  ];
  const scope = buildImageScopeFilters(payload);
  filters.push(...scope.clauses);

  const result = await db
    .prepare(
      `SELECT poi_id, COUNT(*) AS image_count
       FROM ugc_submissions
       WHERE ${filters.join(" AND ")}
       GROUP BY poi_id`
    )
    .bind(...scope.bindings)
    .all<{ poi_id: string; image_count: number | string }>();

  return (result.results ?? []).map((row) => ({
    markerId: String(row.poi_id),
    imageCount: Math.max(0, Math.floor(Number(row.image_count) || 0))
  }));
}
