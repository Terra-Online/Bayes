import type {
  ContributionCursor,
  ContributionQuery,
  ContributionReviewEvidence,
  ReviewEvent,
} from "@/services/me/contract/contributions";

import type { SubmissionKind, SubmissionStatus } from "./submission/types";

type ContributionRow = {
  id: string;
  kind: SubmissionKind;
  poi_id: string;
  poi_type: string;
  content: string | null;
  file_path: string | null;
  status: SubmissionStatus;
  snapshot_id: string;
  revision: number;
  review_status: ContributionReviewEvidence["reviewStatus"];
  created_at: string;
  snapshot_created_at: string;
  author_deleted_at: string | null;
  admin_deleted_at: string | null;
  review_events: string;
};

export type ContributionRecord = ContributionReviewEvidence & {
  id: string;
  kind: SubmissionKind;
  markerId: string;
  poiType: string;
  content: string | null;
  hasImageFile: boolean;
};

type ContributionRecordPage = {
  records: ContributionRecord[];
  nextCursor: string | null;
};

function mapContributionRecord(row: ContributionRow): ContributionRecord {
  return {
    id: row.id,
    kind: row.kind,
    markerId: row.poi_id,
    poiType: row.poi_type,
    content: row.content,
    hasImageFile: Boolean(row.file_path),
    snapshotId: row.snapshot_id,
    revision: row.revision,
    reviewStatus: row.review_status,
    status: row.status,
    createdAt: row.created_at,
    snapshotCreatedAt: row.snapshot_created_at,
    authorDeletedAt: row.author_deleted_at,
    adminDeletedAt: row.admin_deleted_at,
    events: JSON.parse(row.review_events) as ReviewEvent[],
  };
}

// Private archive summaries always select the frontier, even when deleted or
// disabled. Compatibility status describes this version, not its public fallback.
const ownerFrontiers = `SELECT s.id, s.kind, s.poi_id, s.poi_type, s.created_at,
  s.author_deleted_at, s.admin_deleted_at, r.id AS snapshot_id, r.revision,
  r.content, r.file_path, r.created_at AS snapshot_created_at, r.review_status,
  CASE WHEN s.author_deleted_at IS NOT NULL OR s.admin_deleted_at IS NOT NULL
    OR r.review_status IN ('unknown','rejected') THEN 'stale'
    WHEN r.review_status IN ('pending_openai','pending_audit') THEN r.review_status
    WHEN EXISTS (SELECT 1 FROM ugc_submission_flags f
      WHERE f.submission_id=s.id AND f.active=1) THEN 'flagged'
    ELSE 'active' END AS status
  FROM ugc_submissions s
  JOIN ugc_snapshots r ON r.submission_id=s.id AND r.revision=s.revision
  WHERE s.user_id=?1`;

export function encodeContributionCursor(cursor: ContributionCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeContributionCursor(raw: string): ContributionCursor | null {
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ContributionCursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      return null;
    }
    if (!parsed.createdAt || !parsed.id) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function getContributionCounts(db: D1Database, uid: string) {
  const row = await db
    .prepare(
      `SELECT
       SUM(CASE WHEN s.kind = 'image' THEN 1 ELSE 0 END) AS image_count,
       SUM(CASE WHEN s.kind = 'comment' THEN 1 ELSE 0 END) AS comment_count,
       SUM(CASE WHEN s.author_deleted_at IS NULL AND s.admin_deleted_at IS NULL
         AND r.review_status IN ('pending_openai', 'pending_audit') THEN 1 ELSE 0 END) AS pending_count
     FROM ugc_submissions s
     JOIN ugc_snapshots r ON r.submission_id=s.id AND r.revision=s.revision
     WHERE s.user_id = ?1`,
    )
    .bind(uid)
    .first<{
      image_count: number | string;
      comment_count: number | string;
      pending_count: number | string;
    }>();
  return {
    imageCount: Number(row?.image_count ?? 0),
    commentCount: Number(row?.comment_count ?? 0),
    pendingCount: Number(row?.pending_count ?? 0),
  };
}

type Preview = { file_path: string; mime_type: string | null };
export async function listContributionRecords(
  db: D1Database,
  payload: ContributionQuery,
): Promise<ContributionRecordPage> {
  const filters: string[] = [];
  const bindings: Array<string | number> = [payload.uid];
  if (payload.kind) {
    bindings.push(payload.kind);
    filters.push(`kind = ?${bindings.length}`);
  }
  if (payload.status) {
    bindings.push(payload.status);
    filters.push(`status = ?${bindings.length}`);
  }
  if (payload.cursor) {
    bindings.push(payload.cursor.createdAt, payload.cursor.id);
    filters.push(
      `(created_at < ?${bindings.length - 1} OR (created_at = ?${bindings.length - 1} AND id < ?${bindings.length}))`,
    );
  }
  bindings.push(payload.limit + 1);

  // A snapshot has at most two legal review transitions: automation to manual,
  // then a terminal decision. Audit reads run only for the bounded owner page,
  // use the snapshot index and preserve insertion order even for equal times.
  const result = await db
    .prepare(
      `WITH owner_frontiers AS (${ownerFrontiers}), page AS (
        SELECT * FROM owner_frontiers
        ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?${bindings.length}
      )
      SELECT p.*,
        (SELECT json_group_array(json_object(
          'id', e.id, 'snapshotId', e.snapshot_id,
          'from', e.from_status, 'to', e.to_status, 'source', e.source,
          'adminUserId', e.admin_user_id, 'note', e.note, 'at', e.created_at))
         FROM (SELECT id, snapshot_id, from_status, to_status, source,
           admin_user_id, note, created_at FROM ugc_snapshots_review_audit
           WHERE snapshot_id=p.snapshot_id ORDER BY rowid LIMIT 2) e
        ) AS review_events
      FROM page p ORDER BY created_at DESC, id DESC`,
    )
    .bind(...bindings)
    .all<ContributionRow>();

  const rows = result.results ?? [];
  const hasMore = rows.length > payload.limit;
  const visibleRows = rows.slice(0, payload.limit);
  const records = visibleRows.map(mapContributionRecord);
  const last = visibleRows.at(-1);
  return {
    records,
    nextCursor:
      hasMore && last
        ? encodeContributionCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

export async function getContributionImage(db: D1Database, uid: string, id: string) {
  return db
    .prepare(
      `SELECT r.file_path, r.mime_type
     FROM ugc_submissions s
     JOIN ugc_snapshots r ON r.submission_id=s.id AND r.revision=s.revision
     WHERE s.id=?1 AND s.user_id=?2 AND s.kind='image' AND r.file_path IS NOT NULL
     LIMIT 1`,
    )
    .bind(id, uid)
    .first<Preview>();
}
