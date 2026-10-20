import { AI_ACTIVE_MODERATION_NOTE_PREFIX, AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX, AI_STALE_MODERATION_NOTE_PREFIX, RECALL_MODERATION_NOTE_PREFIX } from "../lib/moderation";
import { buildPublicUgcAssetUrl } from "../lib/publicUgcAssets";
import type { SubmissionKind, SubmissionStatus } from "./submission/types";

type ReviewKey = "uploaded" | "ai" | "manual" | "public" | "archived";
type ReviewStep = { key: ReviewKey; at: string | null };
type ReviewEvent = {
  from: SubmissionStatus;
  to: SubmissionStatus;
  source: "auto_moderation" | "manual_moderation" | "user_action";
  at: string;
  aiReviewed: number;
};

export type ContributionItem = {
  id: string;
  kind: SubmissionKind;
  markerId: string;
  poiType: string;
  content: string | null;
  previewUrl: string | null;
  status: SubmissionStatus;
  visibility: "public" | "private" | "unavailable";
  review: {
    manual: boolean;
    published: boolean;
    times: Record<ReviewKey, string | null>;
    path: ReviewStep[];
  };
  createdAt: string;
};

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

type ContributionCursor = { createdAt: string; id: string };

function visibilityFor(status: SubmissionStatus): ContributionItem["visibility"] {
  if (status === "active" || status === "flagged" || status === "remove_request") return "public";
  if (status === "stale") return "unavailable";
  return "private";
}

function reviewPath(row: ContributionRow): ReviewStep[] {
  const path: ReviewStep[] = [{ key: "uploaded", at: row.created_at }];
  const add = (key: ReviewKey, at: string | null) => {
    const last = path.at(-1);
    if (last?.key === key) last.at = at ?? last.at;
    else path.push({ key, at });
  };
  const events = JSON.parse(row.review_events) as ReviewEvent[];
  // Notifications retained only some older transitions. Seed known earlier
  // stages, but do not claim an interrupted AI review was completed.
  const firstTime = events[0]?.at;
  if (!events.length && !row.manual_at && !row.public_at) {
    // Fixed prefixes were written by older moderation code; they can confirm
    // stages even when no notification timestamp survives.
    const note = row.moderation_note;
    if (note?.startsWith(AI_ACTIVE_MODERATION_NOTE_PREFIX)) {
      add("ai", null);
      add("public", null);
    } else if (note?.startsWith(AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX)) {
      add("ai", null);
      add("manual", null);
    } else if (note?.startsWith(AI_STALE_MODERATION_NOTE_PREFIX)) {
      add("ai", null);
      add("archived", row.status === "stale" ? row.updated_at : null);
      if (row.status !== "stale") add("manual", null);
    }
  }
  if (row.manual_at && (!firstTime || Date.parse(row.manual_at) < Date.parse(firstTime))) {
    add("ai", row.manual_at);
    add("manual", row.manual_at);
  }
  if (row.public_at && (!firstTime || Date.parse(row.public_at) < Date.parse(firstTime))) {
    if (!path.some(step => step.key === "manual") && row.moderation_note?.startsWith(AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX)) {
      add("ai", null);
      add("manual", row.public_at);
    } else if (!path.some(step => step.key === "manual") && !row.manual_review) add("ai", row.public_at);
    else add("manual", row.public_at);
    add("public", row.public_at);
  }
  if (!events.length && row.was_published && !path.some(step => step.key === "public")) add("public", null);
  for (const event of events) {
    // The first captured event may start after unrecorded historical stages.
    if (event.from === "pending_audit" && !path.some(step => step.key === "manual")) add("manual", null);
    if (["active", "flagged", "remove_request"].includes(event.from) && path.at(-1)?.key !== "public") add("public", null);
    if (event.from === "stale" && path.at(-1)?.key !== "archived") add("archived", null);

    if (event.source === "auto_moderation" && event.aiReviewed && event.from === "pending_openai") add("ai", event.at);
    if (event.source === "manual_moderation") add("manual", event.at);
    if (event.source === "user_action" && event.to === "stale") {
      const interrupted = event.from === "pending_openai" ? "ai" : event.from === "pending_audit" ? "manual" : null;
      if (path.at(-1)?.key === interrupted) path.pop();
    }
    if (event.to === "pending_audit") add("manual", event.at);
    if (event.to === "active") add("public", event.at);
    if (event.to === "stale") add("archived", event.at);
  }
  if (!events.length && row.status === "stale" && !row.was_published && row.moderation_note?.startsWith(RECALL_MODERATION_NOTE_PREFIX) && path.at(-1)?.key === "manual") path.pop();
  // Preserve the latest event time when a submission has been restored/reviewed
  // more than once. The notification timestamp may describe its first approval.
  const current: ReviewStep = row.status === "pending_openai"
    ? { key: "ai", at: row.updated_at }
    : row.status === "pending_audit"
      ? { key: "manual", at: row.manual_at ?? row.updated_at }
      : row.status === "stale"
        ? { key: "archived", at: row.updated_at }
        : { key: "public", at: row.public_at };
  const last = path.at(-1);
  if (last?.key !== current.key) add(current.key, current.at);
  else last.at ??= current.at;
  return path;
}

function mapContribution(row: ContributionRow, previewBaseUrl?: string): ContributionItem {
  const path = reviewPath(row);
  const times: ContributionItem["review"]["times"] = { uploaded: null, ai: null, manual: null, public: null, archived: null };
  path.forEach(step => { times[step.key] = step.at; });
  return {
    id: row.id,
    kind: row.kind,
    markerId: row.poi_id,
    poiType: row.poi_type,
    content: row.content,
    previewUrl: row.kind === "image" && row.file_path && previewBaseUrl
      ? buildPublicUgcAssetUrl(previewBaseUrl, `${row.id}/preview`)
      : null,
    status: row.status,
    visibility: visibilityFor(row.status),
    review: {
      manual: path.some(step => step.key === "manual"),
      published: path.some(step => step.key === "public"),
      times,
      path,
    },
    createdAt: row.created_at,
  };
}

export function encodeContributionCursor(cursor: ContributionCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeContributionCursor(raw: string): ContributionCursor | null {
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ContributionCursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    if (!parsed.createdAt || !parsed.id) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function getContributionCounts(db: D1Database, uid: string) {
  const row = await db.prepare(
    `SELECT
       SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END) AS image_count,
       SUM(CASE WHEN kind = 'comment' THEN 1 ELSE 0 END) AS comment_count,
       SUM(CASE WHEN status IN ('pending_openai', 'pending_audit') THEN 1 ELSE 0 END) AS pending_count
     FROM ugc_submissions
     WHERE user_id = ?1`,
  ).bind(uid).first<{ image_count: number | string; comment_count: number | string; pending_count: number | string }>();
  return {
    imageCount: Number(row?.image_count ?? 0),
    commentCount: Number(row?.comment_count ?? 0),
    pendingCount: Number(row?.pending_count ?? 0),
  };
}

type Preview = { file_path: string; mime_type: string | null };
const previewCaches = new WeakMap<D1Database, Map<string, { expiresAt: number; value: Preview | null }>>();
function previewCache(db: D1Database) {
  let cache = previewCaches.get(db);
  if (!cache) {
    cache = new Map();
    previewCaches.set(db, cache);
  }
  return cache;
}
function rememberPreview(db: D1Database, key: string, value: Preview | null, expiresAt = Date.now() + 60_000) {
  const cache = previewCache(db);
  if ((cache.get(key)?.expiresAt ?? 0) >= expiresAt) return value;
  cache.delete(key);
  if (cache.size >= 512) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const entry = { expiresAt, value };
  cache.set(key, entry);
  return value;
}

export async function listContributions(db: D1Database, payload: {
  uid: string;
  kind?: SubmissionKind;
  status?: SubmissionStatus;
  cursor?: ContributionCursor;
  limit: number;
  previewBaseUrl?: string;
}): Promise<{ items: ContributionItem[]; nextCursor: string | null }> {
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
    filters.push(`(created_at < ?${bindings.length - 1} OR (created_at = ?${bindings.length - 1} AND id < ?${bindings.length}))`);
  }
  bindings.push(payload.limit + 1);

  // Match the current snapshot so a previous edit's review does not appear
  // as part of this submission's approval path.
  const result = await db.prepare(
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
  ).bind(...bindings).all<ContributionRow>();

  const rows = result.results ?? [];
  const hasMore = rows.length > payload.limit;
  const visibleRows = rows.slice(0, payload.limit);
  // The list already verified ownership and read each file path. Reuse that
  // result for image requests instead of one extra D1 lookup per thumbnail.
  visibleRows.forEach(row => {
    if (row.kind === "image" && row.file_path) rememberPreview(db,
      JSON.stringify([payload.uid, row.id]),
      { file_path: row.file_path, mime_type: row.mime_type ?? null });
  });
  const last = visibleRows.at(-1);
  return {
    items: visibleRows.map(row => mapContribution(row, payload.previewBaseUrl)),
    nextCursor: hasMore && last
      ? encodeContributionCursor({ createdAt: last.created_at, id: last.id })
      : null,
  };
}

export async function getContributionImage(db: D1Database, uid: string, id: string) {
  const key = JSON.stringify([uid, id]);
  const cached = previewCache(db).get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const expiresAt = Date.now() + 60_000;
  const value = await db.prepare(
    `SELECT file_path, mime_type FROM ugc_submissions
     WHERE id = ?1 AND user_id = ?2 AND kind = 'image' AND file_path IS NOT NULL
     LIMIT 1`
  ).bind(id, uid).first<Preview>();
  return rememberPreview(db, key, value, expiresAt);
}
