import rawManifest from "../../data/imageCoverageManifest.json";
import { buildPointShareUrlForMarker } from "../../lib/pointShare";
import { listVisibleImageCountsByMarker } from "../../repositories/submission/imageCoverage";

export type ImageCoverageScope = {
  pathPrefix?: string;
  excludePathPrefix?: string;
};

export type ImageCoverageMetric = {
  totalPoints: number;
  coveredPoints: number;
  missingPoints: number;
  imageCount: number;
  coverageRate: number;
};

export type ImageCoverageType = ImageCoverageMetric & {
  key: string;
  name: string;
  category: string;
  missingMarkers: Array<{
    markerId: string;
    shortUrl: string;
  }>;
};

export type ImageCoverageCategory = ImageCoverageMetric & {
  key: string;
  name: string;
};

export type ImageCoverageRegion = ImageCoverageMetric & {
  key: string;
  name: string;
  categories: ImageCoverageCategory[];
  types: ImageCoverageType[];
};

export type ImageCoverageResponse = {
  generatedAt: string;
  scope: "prod" | "test";
  manifest: {
    schemaVersion: number;
    generatedAt: string;
    sourceCommit: string;
  };
  total: ImageCoverageMetric;
  regions: ImageCoverageRegion[];
};

type CoverageManifestType = {
  key: string;
  name: string;
  category: string;
  pointIds: string[];
};

type CoverageManifest = {
  schemaVersion: number;
  generatedAt: string;
  sourceCommit: string;
  regions: Record<string, {
    name: string;
    types: CoverageManifestType[];
  }>;
};

const manifest = rawManifest as CoverageManifest;
const CATEGORY_NAMES: Record<string, string> = {
  collection: "收集物",
  archives: "档案",
  exploration: "探索"
};

export async function getImageCoverage(
  db: D1Database,
  payload: {
    scope: "prod" | "test";
    imageScope: ImageCoverageScope;
  }
): Promise<ImageCoverageResponse> {
  const imageRows = await listVisibleImageCountsByMarker(db, payload.imageScope);
  const imageCountByMarker = new Map(imageRows.map((row) => [row.markerId, row.imageCount]));
  const regions = Object.entries(manifest.regions).map(([key, region]) => {
    const types = region.types.map((type) => metricForType(type, imageCountByMarker));
    const categoryKeys = [...new Set(types.map((type) => type.category))];
    const categories = categoryKeys.map((categoryKey) => ({
      key: categoryKey,
      name: CATEGORY_NAMES[categoryKey] ?? categoryKey,
      ...sumMetrics(types.filter((type) => type.category === categoryKey))
    }));

    return {
      key,
      name: region.name,
      categories,
      types,
      ...sumMetrics(types)
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    scope: payload.scope,
    manifest: {
      schemaVersion: manifest.schemaVersion,
      generatedAt: manifest.generatedAt,
      sourceCommit: manifest.sourceCommit
    },
    total: sumMetrics(regions),
    regions
  };
}

function metricForType(
  type: CoverageManifestType,
  imageCountByMarker: Map<string, number>
): ImageCoverageType {
  let coveredPoints = 0;
  let imageCount = 0;
  const missingMarkers: ImageCoverageType["missingMarkers"] = [];
  for (const pointId of type.pointIds) {
    const pointImageCount = imageCountByMarker.get(pointId) ?? 0;
    if (pointImageCount > 0) {
      coveredPoints += 1;
    } else {
      missingMarkers.push({
        markerId: pointId,
        shortUrl: buildPointShareUrlForMarker(pointId, type.key === "archives" ? undefined : type.key)
      });
    }
    imageCount += pointImageCount;
  }

  return {
    key: type.key,
    name: type.name,
    category: type.category,
    missingMarkers,
    ...createMetric(type.pointIds.length, coveredPoints, imageCount)
  };
}

function sumMetrics(metrics: ImageCoverageMetric[]): ImageCoverageMetric {
  return createMetric(
    metrics.reduce((sum, metric) => sum + metric.totalPoints, 0),
    metrics.reduce((sum, metric) => sum + metric.coveredPoints, 0),
    metrics.reduce((sum, metric) => sum + metric.imageCount, 0)
  );
}

function createMetric(
  totalPoints: number,
  coveredPoints: number,
  imageCount: number
): ImageCoverageMetric {
  return {
    totalPoints,
    coveredPoints,
    missingPoints: Math.max(0, totalPoints - coveredPoints),
    imageCount,
    coverageRate: totalPoints > 0 ? coveredPoints / totalPoints : 0
  };
}
