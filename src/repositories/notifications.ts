import { nanoid } from "nanoid";
import type { AuthUser } from "../types/app";
import type { SubmissionKind, SubmissionRecord, SubmissionStatus, SubmissionVoteValue, ViewerVoteValue } from "./submission/types";

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

export interface NotificationMessageRecord extends NotificationTarget {
  id: string;
  notificationId: string;
  actorUserId: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
  createdAt: string;
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
  windowStartedAt: string | null;
  windowExpiresAt: string | null;
  messageCount: number;
  messages: NotificationMessageRecord[];
}

export interface SerializedNotificationItem {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  target: NotificationTarget;
  readAt: string | null;
  createdAt: string;
  isMultiMsg: boolean;
  messages: SerializedNotificationItem[];
}

export interface NotificationCursor {
  createdAt: string;
  id: string;
}

export interface TransitionNotificationPayload {
  submission: SubmissionRecord;
  previousStatus: SubmissionStatus;
  nextStatus: SubmissionStatus;
  moderationNote?: string | null;
  source: "auto_moderation" | "manual_moderation" | "user_action";
  transitionedAt: string;
}

export interface CommentVoteNotificationPayload {
  submissionId: string;
  actor: AuthUser;
  value: SubmissionVoteValue;
  changedAt: string;
}

export interface CommentVoteResult {
  previousVote: ViewerVoteValue;
  currentVote: ViewerVoteValue;
  notifications: NotificationRecord[];
}

export interface NotificationUnreadCounts {
  system: number;
  community: number;
  total: number;
}

const DEFAULT_AGGREGATION_WINDOW_MS = 60_000;
const VOTE_AGGREGATION_WINDOW_MS = 6 * 60 * 60 * 1000;

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
  window_started_at,
  window_expires_at,
  last_event_at,
  message_count
`;

const NOTIFICATION_MESSAGE_SELECT_COLUMNS = `
  id,
  notification_id,
  actor_user_id,
  submission_id,
  parent_submission_id,
  marker_id,
  poi_hash,
  poi_type,
  payload_json,
  dedupe_key,
  created_at
`;

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
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
  const createdAt = String(row.last_event_at ?? row.created_at);
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
    windowStartedAt: nullableString(row.window_started_at),
    windowExpiresAt: nullableString(row.window_expires_at),
    messageCount: Math.max(1, normalizeCount(row.message_count, 1)),
    messages: []
  };
}

function mapNotificationMessage(row: Record<string, unknown>): NotificationMessageRecord {
  return {
    id: String(row.id),
    notificationId: String(row.notification_id),
    actorUserId: nullableString(row.actor_user_id),
    submissionId: nullableString(row.submission_id),
    parentSubmissionId: nullableString(row.parent_submission_id),
    markerId: nullableString(row.marker_id),
    poiHash: nullableString(row.poi_hash),
    poiType: nullableString(row.poi_type),
    payload: parsePayload(row.payload_json),
    dedupeKey: String(row.dedupe_key),
    createdAt: String(row.created_at)
  };
}

export function notificationsFromResult(result: D1Result<Record<string, unknown>> | undefined): NotificationRecord[] {
  return (result?.results ?? []).map((row) => mapNotification(row));
}

export function notificationTypeForTransition(
  previousStatus: SubmissionStatus,
  nextStatus: SubmissionStatus,
  source?: TransitionNotificationPayload["source"]
): NotificationType | null {
  if (previousStatus === nextStatus) return null;
  if (previousStatus === "remove_request" && (nextStatus === "active" || nextStatus === "stale")) {
    return "system.remove_request.resolved";
  }
  if (source === "user_action" && nextStatus === "stale") {
    return "system.remove_request.resolved";
  }
  if (nextStatus === "active") return "system.submission.approved";
  if (nextStatus === "pending_audit") return "system.submission.needs_review";
  return null;
}

function serializePayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function expiresAt(createdAt: string, windowMs = DEFAULT_AGGREGATION_WINDOW_MS): string {
  return new Date(Date.parse(createdAt) + windowMs).toISOString();
}

function systemPayload(kind: SubmissionKind): Record<string, unknown> {
  return { kind };
}

function communityPayload(kind: SubmissionKind): Record<string, unknown> {
  return { kind };
}

function appendParentUpdateStatement(
  db: D1Database,
  messageId: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE notifications
       SET message_count = message_count + 1,
           last_event_at = (
             SELECT created_at
             FROM notification_messages
             WHERE id = ?1
           ),
           read_at = NULL
       WHERE id = (
         SELECT notification_id
         FROM notification_messages
         WHERE id = ?1
       )
       RETURNING ${NOTIFICATION_SELECT_COLUMNS}`
    )
    .bind(messageId);
}

export function prepareSubmissionStatusNotificationWrite(
  db: D1Database,
  payload: TransitionNotificationPayload
): D1PreparedStatement[] {
  const type = notificationTypeForTransition(payload.previousStatus, payload.nextStatus, payload.source);
  if (!type) return [];

  const notificationId = nanoid(18);
  const messageId = nanoid(18);
  const createdAt = payload.transitionedAt;
  const openKey = JSON.stringify(["system", payload.submission.userId, type, payload.submission.kind]);
  const eventDedupeKey = [
    "system",
    payload.submission.id,
    payload.submission.snapshotId,
    payload.previousStatus,
    payload.nextStatus
  ].join(":");
  const payloadJson = serializePayload(systemPayload(payload.submission.kind));

  return [
    db.prepare(
      `UPDATE notifications
       SET open_aggregation_key = NULL
       WHERE open_aggregation_key = ?1
         AND window_expires_at <= ?2`
    ).bind(openKey, createdAt),
    db.prepare(
      `INSERT INTO notifications (
         id, recipient_user_id, category, type, actor_user_id,
         submission_id, parent_submission_id, marker_id, poi_hash, poi_type,
         payload_json, dedupe_key, read_at, created_at,
         open_aggregation_key, window_started_at, window_expires_at,
         last_event_at, message_count
       )
       SELECT
         ?1, s.user_id, 'system', ?2, NULL,
         s.id, s.parent_id, s.poi_id, s.poi_hash, s.poi_type,
         ?3, ?4, NULL, ?5,
         ?6, ?5, ?7, ?5, 0
       FROM ugc_submissions s
       WHERE s.id = ?8
         AND s.snapshot_id = ?9
         AND s.status = ?10
         AND s.updated_at = ?5
         AND NOT EXISTS (
           SELECT 1 FROM notification_messages WHERE dedupe_key = ?11
         )
       ON CONFLICT(open_aggregation_key) DO NOTHING`
    ).bind(
      notificationId,
      type,
      payloadJson,
      `group:${notificationId}`,
      createdAt,
      openKey,
      expiresAt(createdAt),
      payload.submission.id,
      payload.submission.snapshotId,
      payload.nextStatus,
      eventDedupeKey
    ),
    db.prepare(
      `INSERT INTO notification_messages (
         id, notification_id, actor_user_id, submission_id, parent_submission_id,
         marker_id, poi_hash, poi_type, payload_json, dedupe_key, created_at
       )
       SELECT
         ?1, n.id, NULL, s.id, s.parent_id,
         s.poi_id, s.poi_hash, s.poi_type, ?2, ?3, ?4
       FROM ugc_submissions s
       INNER JOIN notifications n ON n.open_aggregation_key = ?5
       WHERE s.id = ?6
         AND s.snapshot_id = ?7
         AND s.status = ?8
         AND s.updated_at = ?4
         AND ?4 < n.window_expires_at
       ON CONFLICT(dedupe_key) DO NOTHING`
    ).bind(
      messageId,
      payloadJson,
      eventDedupeKey,
      createdAt,
      openKey,
      payload.submission.id,
      payload.submission.snapshotId,
      payload.nextStatus
    ),
    appendParentUpdateStatement(db, messageId)
  ];
}

export function prepareApprovedReplyNotificationWrite(
  db: D1Database,
  payload: TransitionNotificationPayload
): D1PreparedStatement[] {
  if (!payload.submission.parentId) return [];

  const notificationId = nanoid(18);
  const messageId = nanoid(18);
  const createdAt = payload.transitionedAt;
  const openKey = JSON.stringify(["community", "reply", payload.submission.parentId]);
  const eventDedupeKey = `reply:${payload.submission.id}`;
  const payloadJson = serializePayload(communityPayload("comment"));

  return [
    db.prepare(
      `UPDATE notifications
       SET open_aggregation_key = NULL
       WHERE open_aggregation_key = ?1
         AND window_expires_at <= ?2`
    ).bind(openKey, createdAt),
    db.prepare(
      `INSERT INTO notifications (
         id, recipient_user_id, category, type, actor_user_id,
         submission_id, parent_submission_id, marker_id, poi_hash, poi_type,
         payload_json, dedupe_key, read_at, created_at,
         open_aggregation_key, window_started_at, window_expires_at,
         last_event_at, message_count
       )
       SELECT
         ?1, parent.user_id, 'community', 'community.comment.reply', child.user_id,
         child.id, parent.id, child.poi_id, child.poi_hash, child.poi_type,
         ?2, ?3, NULL, ?4,
         ?5, ?4, ?6, ?4, 0
       FROM ugc_submissions child
       INNER JOIN ugc_submissions parent ON parent.id = child.parent_id
       WHERE child.id = ?7
         AND child.snapshot_id = ?8
         AND child.status = 'active'
         AND child.updated_at = ?4
         AND child.kind = 'comment'
         AND parent.kind = 'comment'
         AND parent.user_id <> child.user_id
         AND NOT EXISTS (
           SELECT 1 FROM notification_messages WHERE dedupe_key = ?9
         )
       ON CONFLICT(open_aggregation_key) DO NOTHING`
    ).bind(
      notificationId,
      payloadJson,
      `group:${notificationId}`,
      createdAt,
      openKey,
      expiresAt(createdAt),
      payload.submission.id,
      payload.submission.snapshotId,
      eventDedupeKey
    ),
    db.prepare(
      `INSERT INTO notification_messages (
         id, notification_id, actor_user_id, submission_id, parent_submission_id,
         marker_id, poi_hash, poi_type, payload_json, dedupe_key, created_at
       )
       SELECT
         ?1, n.id, child.user_id, child.id, parent.id,
         child.poi_id, child.poi_hash, child.poi_type, ?2, ?3, ?4
       FROM ugc_submissions child
       INNER JOIN ugc_submissions parent ON parent.id = child.parent_id
       INNER JOIN notifications n ON n.open_aggregation_key = ?5
       WHERE child.id = ?6
         AND child.snapshot_id = ?7
         AND child.status = 'active'
         AND child.updated_at = ?4
         AND child.kind = 'comment'
         AND parent.kind = 'comment'
         AND parent.user_id <> child.user_id
         AND ?4 < n.window_expires_at
       ON CONFLICT(dedupe_key) DO NOTHING`
    ).bind(
      messageId,
      payloadJson,
      eventDedupeKey,
      createdAt,
      openKey,
      payload.submission.id,
      payload.submission.snapshotId
    ),
    appendParentUpdateStatement(db, messageId)
  ];
}

export function prepareCommentVoteNotificationWrite(
  db: D1Database,
  payload: CommentVoteNotificationPayload
): D1PreparedStatement[] {
  if (payload.value !== 1) return [];

  return prepareCommunityVoteNotificationWrite(db, {
    ...payload,
    kind: "comment"
  });
}

export interface ImageUpvoteNotificationPayload {
  submissionId: string;
  actor: AuthUser;
  changedAt: string;
}

export function prepareImageUpvoteNotificationWrite(
  db: D1Database,
  payload: ImageUpvoteNotificationPayload
): D1PreparedStatement[] {
  return prepareCommunityVoteNotificationWrite(db, {
    submissionId: payload.submissionId,
    actor: payload.actor,
    value: 1,
    changedAt: payload.changedAt,
    kind: "image"
  });
}

function prepareCommunityVoteNotificationWrite(
  db: D1Database,
  payload: CommentVoteNotificationPayload & { kind: SubmissionKind }
): D1PreparedStatement[] {
  if (payload.value !== 1) return [];

  const notificationId = nanoid(18);
  const messageId = nanoid(18);
  const createdAt = payload.changedAt;
  const openKey = JSON.stringify(["community", "vote", payload.submissionId]);
  const eventDedupeKey = `vote:${payload.submissionId}:${payload.actor.uid}:${createdAt}`;
  const basePayloadJson = serializePayload(communityPayload(payload.kind));
  const voteSource = payload.kind === "image"
    ? `
       INNER JOIN ugc_submission_upvotes v
         ON v.submission_id = s.id
        AND v.user_id = ?2
        AND v.active = 1
        AND v.created_at = ?5`
    : `
       INNER JOIN ugc_submission_votes v
         ON v.submission_id = s.id
        AND v.user_id = ?2
        AND v.value = 1
        AND v.active = 1
        AND v.updated_at = ?5`;

  return [
    db.prepare(
      `UPDATE notifications
       SET open_aggregation_key = NULL
       WHERE open_aggregation_key = ?1
         AND window_expires_at <= ?2`
    ).bind(openKey, createdAt),
    db.prepare(
      `INSERT INTO notifications (
         id, recipient_user_id, category, type, actor_user_id,
         submission_id, parent_submission_id, marker_id, poi_hash, poi_type,
         payload_json, dedupe_key, read_at, created_at,
         open_aggregation_key, window_started_at, window_expires_at,
         last_event_at, message_count
       )
       SELECT
         ?1, s.user_id, 'community', 'community.comment.vote', ?2,
         s.id, s.parent_id, s.poi_id, s.poi_hash, s.poi_type,
         ?3,
         ?4, NULL, ?5,
         ?6, ?5, ?7, ?5, 0
       FROM ugc_submissions s${voteSource}
       WHERE s.id = ?8
         AND s.kind = ?10
         AND s.status IN ('active', 'flagged', 'remove_request')
         AND s.user_id <> ?2
         AND NOT EXISTS (
           SELECT 1 FROM notification_messages WHERE dedupe_key = ?9
         )
       ON CONFLICT(open_aggregation_key) DO NOTHING`
    ).bind(
      notificationId,
      payload.actor.uid,
      basePayloadJson,
      `group:${notificationId}`,
      createdAt,
      openKey,
      expiresAt(createdAt, VOTE_AGGREGATION_WINDOW_MS),
      payload.submissionId,
      eventDedupeKey,
      payload.kind
    ),
    db.prepare(
      `INSERT INTO notification_messages (
         id, notification_id, actor_user_id, submission_id, parent_submission_id,
         marker_id, poi_hash, poi_type, payload_json, dedupe_key, created_at
       )
       SELECT
         ?1, n.id, ?2, s.id, s.parent_id,
         s.poi_id, s.poi_hash, s.poi_type,
         ?3,
         ?4, ?5
       FROM ugc_submissions s${voteSource}
       INNER JOIN notifications n ON n.open_aggregation_key = ?6
       WHERE s.id = ?7
         AND s.kind = ?8
         AND s.status IN ('active', 'flagged', 'remove_request')
         AND s.user_id <> ?2
         AND ?5 < n.window_expires_at
       ON CONFLICT(dedupe_key) DO NOTHING`
    ).bind(
      messageId,
      payload.actor.uid,
      basePayloadJson,
      eventDedupeKey,
      createdAt,
      openKey,
      payload.submissionId,
      payload.kind
    ),
    appendParentUpdateStatement(db, messageId)
  ];
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return encodeURIComponent(`${cursor.createdAt}|${cursor.id}`);
}

export function decodeNotificationCursor(raw: string | undefined): NotificationCursor | null {
  if (!raw?.trim()) return null;
  const decoded = decodeURIComponent(raw.trim());
  const separatorIndex = decoded.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex >= decoded.length - 1) return null;
  return {
    createdAt: decoded.slice(0, separatorIndex),
    id: decoded.slice(separatorIndex + 1)
  };
}

async function hydrateNotificationMessages(
  db: D1Database,
  notifications: NotificationRecord[]
): Promise<NotificationRecord[]> {
  if (notifications.length === 0) return notifications;
  const placeholders = notifications.map((_, index) => `?${index + 1}`).join(", ");
  const result = await db
    .prepare(
      `SELECT ${NOTIFICATION_MESSAGE_SELECT_COLUMNS}
       FROM notification_messages
       WHERE notification_id IN (${placeholders})
       ORDER BY created_at ASC, id ASC`
    )
    .bind(...notifications.map((item) => item.id))
    .all<Record<string, unknown>>();
  const grouped = new Map<string, NotificationMessageRecord[]>();
  for (const row of result.results ?? []) {
    const message = mapNotificationMessage(row);
    const messages = grouped.get(message.notificationId) ?? [];
    messages.push(message);
    grouped.set(message.notificationId, messages);
  }
  return notifications.map((notification) => ({
    ...notification,
    messages: grouped.get(notification.id) ?? []
  }));
}

export async function getNotificationById(
  db: D1Database,
  id: string
): Promise<NotificationRecord | null> {
  const row = await db
    .prepare(`SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM notifications WHERE id = ?1 LIMIT 1`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const [notification] = await hydrateNotificationMessages(db, [mapNotification(row)]);
  return notification ?? null;
}

export async function listNotifications(
  db: D1Database,
  payload: {
    userId: string;
    category: NotificationCategory;
    limit: number;
    cursor?: NotificationCursor | null;
    unreadOnly?: boolean;
  }
): Promise<{ items: NotificationRecord[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(payload.limit, 1), 50);
  const conditions = ["recipient_user_id = ?1", "category = ?2"];
  const bindings: unknown[] = [payload.userId, payload.category];
  if (payload.unreadOnly) conditions.push("read_at IS NULL");
  if (payload.cursor) {
    const createdAtIndex = bindings.length + 1;
    const idIndex = bindings.length + 2;
    conditions.push(
      `(COALESCE(last_event_at, created_at) < ?${createdAtIndex} OR ` +
      `(COALESCE(last_event_at, created_at) = ?${createdAtIndex} AND id < ?${idIndex}))`
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
       ORDER BY COALESCE(last_event_at, created_at) DESC, id DESC
       LIMIT ?${limitIndex}`
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();

  const rows = (result.results ?? []).map((row) => mapNotification(row));
  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;
  const items = await hydrateNotificationMessages(db, page);
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasNext && last ? encodeNotificationCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}

function targetOf(item: NotificationTarget): NotificationTarget {
  return {
    submissionId: item.submissionId,
    parentSubmissionId: item.parentSubmissionId,
    markerId: item.markerId,
    poiHash: item.poiHash,
    poiType: item.poiType
  };
}

function commonTarget(messages: NotificationMessageRecord[]): NotificationTarget {
  const first = messages[0];
  if (!first) return targetOf({
    submissionId: null,
    parentSubmissionId: null,
    markerId: null,
    poiHash: null,
    poiType: null
  });
  const target = targetOf(first);
  const matches = messages.every((message) => (
    message.submissionId === target.submissionId &&
    message.parentSubmissionId === target.parentSubmissionId &&
    message.markerId === target.markerId &&
    message.poiHash === target.poiHash &&
    message.poiType === target.poiType
  ));
  return matches ? target : {
    submissionId: null,
    parentSubmissionId: null,
    markerId: null,
    poiHash: null,
    poiType: null
  };
}

function minimalPayload(type: NotificationType, payload: Record<string, unknown>): Record<string, unknown> {
  if (type.startsWith("system.")) {
    return { kind: payload.kind === "comment" ? "comment" : "image" };
  }
  return { kind: payload.kind === "image" ? "image" : "comment" };
}

function serializeMessage(
  parent: NotificationRecord,
  message: NotificationMessageRecord
): SerializedNotificationItem {
  return {
    id: message.id,
    type: parent.type,
    payload: minimalPayload(parent.type, message.payload),
    target: targetOf(message),
    readAt: parent.readAt,
    createdAt: message.createdAt,
    isMultiMsg: false,
    messages: []
  };
}

export function serializeNotificationItem(notification: NotificationRecord): SerializedNotificationItem {
  const messages = notification.messages;
  if (messages.length <= 1) {
    const message = messages[0];
    return {
      id: notification.id,
      type: notification.type,
      payload: minimalPayload(notification.type, message?.payload ?? notification.payload),
      target: message ? targetOf(message) : targetOf(notification),
      readAt: notification.readAt,
      createdAt: message?.createdAt ?? notification.createdAt,
      isMultiMsg: false,
      messages: []
    };
  }

  const firstPayload = minimalPayload(notification.type, messages[0]?.payload ?? notification.payload);
  const kind = firstPayload.kind === "image" || firstPayload.kind === "comment"
    ? firstPayload.kind
    : undefined;
  return {
    id: notification.id,
    type: notification.type,
    payload: {
      ...(kind ? { kind } : {}),
      messageCount: messages.length
    },
    target: commonTarget(messages),
    readAt: notification.readAt,
    createdAt: notification.createdAt,
    isMultiMsg: true,
    messages: messages.map((message) => serializeMessage(notification, message))
  };
}

export async function getNotificationUnreadCount(
  db: D1Database,
  userId: string,
  category: NotificationCategory
): Promise<number> {
  const counts = await getNotificationUnreadCounts(db, userId);
  return counts[category];
}

export async function getNotificationUnreadCounts(
  db: D1Database,
  userId: string
): Promise<NotificationUnreadCounts> {
  const row = await db
    .prepare(
      `SELECT system_unread, community_unread
       FROM notification_counters
       WHERE user_id = ?1
       LIMIT 1`
    )
    .bind(userId)
    .first<{ system_unread: number | string; community_unread: number | string }>();
  const system = normalizeCount(row?.system_unread);
  const community = normalizeCount(row?.community_unread);
  return { system, community, total: system + community };
}

export async function markNotificationRead(
  db: D1Database,
  payload: { userId: string; category: NotificationCategory; id: string }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, ?4)
       WHERE id = ?1
         AND recipient_user_id = ?2
         AND category = ?3`
    )
    .bind(payload.id, payload.userId, payload.category, new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markNotificationsRead(
  db: D1Database,
  payload: { userId: string; category: NotificationCategory; ids: string[] }
): Promise<number> {
  const ids = [...new Set(payload.ids.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (ids.length === 0) return 0;
  const result = await db
    .prepare(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, ?3)
       WHERE recipient_user_id = ?1
         AND category = ?2
         AND id IN (SELECT value FROM json_each(?4))`
    )
    .bind(payload.userId, payload.category, new Date().toISOString(), JSON.stringify(ids))
    .run();
  return result.meta.changes ?? 0;
}

export async function markAllNotificationsRead(
  db: D1Database,
  payload: { userId: string; category: NotificationCategory }
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE notifications
       SET read_at = ?3
       WHERE recipient_user_id = ?1
         AND category = ?2
         AND read_at IS NULL`
    )
    .bind(payload.userId, payload.category, new Date().toISOString())
    .run();
  return result.meta.changes ?? 0;
}
