export type NotificationCategory = "system" | "community";

export type NotificationType =
  | "system.submission.approved"
  | "system.submission.needs_review"
  | "system.remove_request.resolved"
  | "community.comment.reply"
  | "community.comment.vote";

export interface NotificationTarget {
  submissionId: string | null;
  parentSubmissionId: string | null;
  markerId: string | null;
  poiHash: string | null;
  poiType: string | null;
}

export interface NotificationRecord extends NotificationTarget {
  id: string;
  recipientUserId: string;
  category: NotificationCategory;
  type: NotificationType;
  actorUserId: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
  readAt: string | null;
  createdAt: string;
  projectedAt?: string;
}

export interface SerializedNotificationItem {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  target: NotificationTarget;
  readAt: string | null;
  createdAt: string;
  projectedAt?: string;
  isMultiMsg: boolean;
  messages: SerializedNotificationItem[];
}

export interface NotificationCursor {
  createdAt: string;
  id: string;
}

export interface NotificationUnreadCounts {
  system: number;
  community: number;
  total: number;
}

const NOTIFICATION_SELECT_COLUMNS = `
  id,
  recipient_user_id,
  category,
  type,
  actor_user_id,
  submission_id,
  parent_submission_id,
  marker_id,
  poi_hash,
  poi_type,
  payload_json,
  dedupe_key,
  read_at,
  created_at,
  projected_at
`;

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function nullableString(raw: unknown): string | null {
  return raw === null || raw === undefined ? null : String(raw);
}

function normalizeNotificationType(raw: unknown): NotificationType {
  const value = String(raw ?? "");
  if (
    value === "system.submission.approved" ||
    value === "system.submission.needs_review" ||
    value === "system.remove_request.resolved" ||
    value === "community.comment.reply" ||
    value === "community.comment.vote"
  ) {
    return value;
  }
  return "system.submission.needs_review";
}

function normalizeNotificationCategory(raw: unknown): NotificationCategory {
  return raw === "community" ? "community" : "system";
}

function normalizeCount(raw: unknown, fallback = 0): number {
  const count = Number(raw ?? fallback);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : fallback;
}

export function mapNotification(row: Record<string, unknown>): NotificationRecord {
  const createdAt = String(row.created_at);
  return {
    id: String(row.id),
    recipientUserId: String(row.recipient_user_id),
    category: normalizeNotificationCategory(row.category),
    type: normalizeNotificationType(row.type),
    actorUserId: nullableString(row.actor_user_id),
    submissionId: nullableString(row.submission_id),
    parentSubmissionId: nullableString(row.parent_submission_id),
    markerId: nullableString(row.marker_id),
    poiHash: nullableString(row.poi_hash),
    poiType: nullableString(row.poi_type),
    payload: parsePayload(row.payload_json),
    dedupeKey: String(row.dedupe_key),
    readAt: nullableString(row.read_at),
    createdAt,
    projectedAt: String(row.projected_at ?? row.created_at),
  };
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return encodeURIComponent(`${cursor.createdAt}|${cursor.id}`);
}

export function decodeNotificationCursor(raw: string | undefined): NotificationCursor | null {
  if (!raw?.trim()) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.trim());
  } catch {
    // Malformed percent escapes follow the existing invalid-cursor fallback.
    return null;
  }
  const separatorIndex = decoded.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex >= decoded.length - 1) {
    return null;
  }
  return {
    createdAt: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1),
  };
}

export async function getNotificationById(
  db: D1Database,
  id: string,
): Promise<NotificationRecord | null> {
  const row = await db
    .prepare(`SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM notifications WHERE id = ?1 LIMIT 1`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) {
    return null;
  }
  return mapNotification(row);
}

export async function listNotifications(
  db: D1Database,
  payload: {
    userId: string;
    category: NotificationCategory;
    limit: number;
    cursor?: NotificationCursor | null;
    unreadOnly?: boolean;
  },
): Promise<{ items: NotificationRecord[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(payload.limit, 1), 50);
  const conditions = ["recipient_user_id = ?1", "category = ?2"];
  const bindings: unknown[] = [payload.userId, payload.category];
  if (payload.unreadOnly) {
    conditions.push("read_at IS NULL");
  }
  if (payload.cursor) {
    const createdAtIndex = bindings.length + 1;
    const idIndex = bindings.length + 2;
    conditions.push(
      `(created_at < ?${createdAtIndex} OR ` +
        `(created_at = ?${createdAtIndex} AND id < ?${idIndex}))`,
    );
    bindings.push(payload.cursor.createdAt, payload.cursor.id);
  }
  const limitIndex = bindings.length + 1;
  bindings.push(limit + 1);

  const result = await db
    .prepare(
      `SELECT ${NOTIFICATION_SELECT_COLUMNS}
       FROM notifications
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?${limitIndex}`,
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();

  const rows = (result.results ?? []).map((row) => mapNotification(row));
  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;
  const items = page;
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasNext && last ? encodeNotificationCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

function targetOf(item: NotificationTarget): NotificationTarget {
  return {
    submissionId: item.submissionId,
    parentSubmissionId: item.parentSubmissionId,
    markerId: item.markerId,
    poiHash: item.poiHash,
    poiType: item.poiType,
  };
}

function minimalPayload(
  type: NotificationType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (type.startsWith("system.")) {
    return { kind: payload.kind === "comment" ? "comment" : "image" };
  }
  return { kind: payload.kind === "image" ? "image" : "comment" };
}

export function serializeNotificationItem(
  notification: NotificationRecord,
): SerializedNotificationItem {
  return {
    id: notification.id,
    type: notification.type,
    payload: minimalPayload(notification.type, notification.payload),
    target: targetOf(notification),
    readAt: notification.readAt,
    createdAt: notification.createdAt,
    ...(notification.projectedAt ? { projectedAt: notification.projectedAt } : {}),
    isMultiMsg: false,
    messages: [],
  };
}

export async function getNotificationUnreadCounts(
  db: D1Database,
  userId: string,
): Promise<NotificationUnreadCounts> {
  const row = await db
    .prepare(
      `SELECT system_unread, community_unread
       FROM notification_counters
       WHERE user_id = ?1
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ system_unread: number | string; community_unread: number | string }>();
  const system = normalizeCount(row?.system_unread);
  const community = normalizeCount(row?.community_unread);
  return { system, community, total: system + community };
}

// Use the same cutoff in storage and live events so delayed read delivery cannot
// mark a subsequently projected notification read, even if its event is older.
export async function markNotificationRead(
  db: D1Database,
  payload: { userId: string; category: NotificationCategory; readAt?: string; id: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, ?4)
       WHERE id = ?1
         AND recipient_user_id = ?2
         AND category = ?3
         AND read_at IS NULL
         AND julianday(MAX(created_at,projected_at)) <= julianday(?4)`,
    )
    .bind(payload.id, payload.userId, payload.category, payload.readAt ?? new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markNotificationsRead(
  db: D1Database,
  payload: { userId: string; category: NotificationCategory; readAt?: string; ids: string[] },
): Promise<number> {
  const ids = [...new Set(payload.ids.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (ids.length === 0) {
    return 0;
  }
  const result = await db
    .prepare(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, ?3)
       WHERE recipient_user_id = ?1
         AND category = ?2
         AND id IN (SELECT value FROM json_each(?4))
         AND read_at IS NULL
         AND julianday(MAX(created_at,projected_at)) <= julianday(?3)`,
    )
    .bind(
      payload.userId,
      payload.category,
      payload.readAt ?? new Date().toISOString(),
      JSON.stringify(ids),
    )
    .run();
  return result.meta.changes ?? 0;
}

export async function markAllNotificationsRead(
  db: D1Database,
  payload: { userId: string; category: NotificationCategory; readAt?: string },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE notifications
       SET read_at = ?3
       WHERE recipient_user_id = ?1
         AND category = ?2
         AND read_at IS NULL
         AND julianday(MAX(created_at,projected_at)) <= julianday(?3)`,
    )
    .bind(payload.userId, payload.category, payload.readAt ?? new Date().toISOString())
    .run();
  return result.meta.changes ?? 0;
}
