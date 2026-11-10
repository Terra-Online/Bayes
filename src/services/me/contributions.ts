import { buildPublicUgcAssetUrl } from "@/lib/publicUgcAssets";
import { listContributionRecords } from "@/repositories/me";

import type { ContributionPage, ContributionQuery } from "./contract/contributions";
import { projectContributionReview } from "./contributionReview";

export async function listContributions(
  db: D1Database,
  query: ContributionQuery & { previewBaseUrl?: string },
): Promise<ContributionPage> {
  const page = await listContributionRecords(db, query);
  return {
    items: page.records.map((record) => {
      const projection = projectContributionReview(record);
      return {
        id: record.id,
        kind: record.kind,
        markerId: record.markerId,
        poiType: record.poiType,
        content: record.content,
        previewUrl:
          record.kind === "image" && record.hasImageFile && query.previewBaseUrl
            ? buildPublicUgcAssetUrl(query.previewBaseUrl, `${record.id}/preview`)
            : null,
        status: record.status,
        snapshotId: record.snapshotId,
        revision: record.revision,
        reviewStatus: record.reviewStatus,
        authorDeletedAt: record.authorDeletedAt,
        adminDeletedAt: record.adminDeletedAt,
        visibility: projection.visibility,
        review: projection.review,
        createdAt: record.createdAt,
      };
    }),
    nextCursor: page.nextCursor,
  };
}
