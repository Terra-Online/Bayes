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
  mime_type?: string | null;
  status: SubmissionStatus;
  created_at: string;
  updated_at: string;
  manual_at: string | null;
  public_at: string | null;
  manual_review: number;
  was_published: number;
  review_events: string;
  moderation_note: string | null;
};

export type ContributionRecord = {
  id: string;
  kind: SubmissionKind;
  markerId: string;
  poiType: string;
  content: string | null;
  hasImageFile: boolean;
  reviewEvidence: ContributionReviewEvidence;
};

type ContributionRecordPage = {
  records: ContributionRecord[];
  nextCursor: string | null;
};

function mapContributionRecord(row: ContributionRow): ContributionRecord {
  const events = JSON.parse(row.review_events) as ReviewEvent[];
  // Normalize SQLite's numeric flags on the freshly decoded objects before
  // exposing them as evidence, without copying every historical event.
  for (const event of events) {
    event.aiReviewed = Boolean(event.aiReviewed);
  }
  return {
    id: row.id,
    kind: row.kind,
    markerId: row.poi_id,
    poiType: row.poi_type,
    content: row.content,
    hasImageFile: Boolean(row.file_path),
    reviewEvidence: {
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      events,
      legacy: {
        manualAt: row.manual_at,
        publicAt: row.public_at,
        hasManualEvidence: Boolean(row.manual_review),
        hasPublicationEvidence: Boolean(row.was_published),
        moderationNote: row.moderation_note,
      },
    },
  };
}

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
       SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END) AS image_count,
       SUM(CASE WHEN kind = 'comment' THEN 1 ELSE 0 END) AS comment_count,
       SUM(CASE WHEN status IN ('pending_openai', 'pending_audit') THEN 1 ELSE 0 END) AS pending_count
     FROM ugc_submissions
     WHERE user_id = ?1`,
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
const previewCaches = new WeakMap<
  D1Database,
  Map<string, { expiresAt: number; value: Preview | null }>
>();
function previewCache(db: D1Database) {
  let cache = previewCaches.get(db);
  if (!cache) {
    cache = new Map();
    previewCaches.set(db, cache);
  }
  return cache;
}
function rememberPreview(
  db: D1Database,
  key: string,
  value: Preview | null,
  expiresAt = Date.now() + 60_000,
) {
  const cache = previewCache(db);
  if ((cache.get(key)?.expiresAt ?? 0) >= expiresAt) {
    return value;
  }
  cache.delete(key);
  if (cache.size >= 512) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  const entry = { expiresAt, value };
  cache.set(key, entry);
  return value;
}

export async function listContributionRecords(
  db: D1Database,
  payload: ContributionQuery,
): Promise<ContributionRecordPage> {
  const filters = ["user_id = ?1"];
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

  // Match the current snapshot so a previous edit's review does not appear
  // as part of this submission's approval path.
  const result = await db
    .prepare(
      `SELECT s.id, s.kind, s.poi_id, s.poi_type, s.content, s.file_path, s.mime_type, s.status, s.created_at, s.updated_at, s.moderation_note,
       (SELECT MIN(m.created_at) FROM notification_messages m
        WHERE m.submission_id = s.id
          AND m.dedupe_key = 'system:' || s.id || ':' || s.snapshot_id || ':pending_openai:pending_audit'
       ) AS manual_at,
       (SELECT MIN(m.created_at) FROM notification_messages m
        WHERE m.submission_id = s.id
          AND m.dedupe_key IN (
            'system:' || s.id || ':' || s.snapshot_id || ':pending_openai:active',
            'system:' || s.id || ':' || s.snapshot_id || ':pending_audit:active'
          )
       ) AS public_at,
       (s.status = 'pending_audit' OR EXISTS (
         SELECT 1 FROM notification_messages m
         WHERE m.submission_id = s.id
           AND m.dedupe_key IN (
             'system:' || s.id || ':' || s.snapshot_id || ':pending_openai:pending_audit',
             'system:' || s.id || ':' || s.snapshot_id || ':pending_audit:active',
             'system:' || s.id || ':' || s.snapshot_id || ':pending_audit:stale'
           )
       )) AS manual_review,
       (s.status IN ('active', 'flagged', 'remove_request') OR EXISTS (
         SELECT 1 FROM notification_messages m
         WHERE m.submission_id = s.id
           AND m.dedupe_key IN (
             'system:' || s.id || ':' || s.snapshot_id || ':pending_openai:active',
             'system:' || s.id || ':' || s.snapshot_id || ':pending_audit:active',
             'system:' || s.id || ':' || s.snapshot_id || ':active:stale',
             'system:' || s.id || ':' || s.snapshot_id || ':flagged:stale',
             'system:' || s.id || ':' || s.snapshot_id || ':remove_request:stale'
           )
       )) AS was_published,
       (SELECT json_group_array(json_object('from', e.from_status, 'to', e.to_status, 'source', e.source, 'at', e.created_at, 'aiReviewed', e.ai_reviewed))
        FROM (SELECT * FROM ugc_review_events
              WHERE submission_id = s.id AND snapshot_id = s.snapshot_id ORDER BY id) e
       ) AS review_events
     FROM ugc_submissions s
     WHERE ${filters.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ?${bindings.length}`,
    )
    .bind(...bindings)
    .all<ContributionRow>();

  const rows = result.results ?? [];
  const hasMore = rows.length > payload.limit;
  const visibleRows = rows.slice(0, payload.limit);
  // The list already verified ownership and read each file path. Reuse that
  // result for image requests instead of one extra D1 lookup per thumbnail.
  visibleRows.forEach((row) => {
    if (row.kind === "image" && row.file_path) {
      rememberPreview(db, JSON.stringify([payload.uid, row.id]), {
        file_path: row.file_path,
        mime_type: row.mime_type ?? null,
      });
    }
  });
  const last = visibleRows.at(-1);
  return {
    records: visibleRows.map(mapContributionRecord),
    nextCursor:
      hasMore && last
        ? encodeContributionCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

export async function getContributionImage(db: D1Database, uid: string, id: string) {
  const key = JSON.stringify([uid, id]);
  const cached = previewCache(db).get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const expiresAt = Date.now() + 60_000;
  const value = await db
    .prepare(
      `SELECT file_path, mime_type FROM ugc_submissions
     WHERE id = ?1 AND user_id = ?2 AND kind = 'image' AND file_path IS NOT NULL
     LIMIT 1`,
    )
    .bind(id, uid)
    .first<Preview>();
  return rememberPreview(db, key, value, expiresAt);
}
