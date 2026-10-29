import { nanoid } from "nanoid";

import { notificationsFromResult, type NotificationRecord } from "@/repositories/notifications";

import type { ReviewCommand } from "./reviewSnapshot";
import type { SubmissionKind } from "./types";

interface ReviewNotificationPayload {
  command: ReviewCommand;
  transitionedAt: string;
}
const DEFAULT_AGGREGATION_WINDOW_MS = 60_000;
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
  messageId: string,
  auditId: string,
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
         AND EXISTS (SELECT 1 FROM ugc_snapshots_review_audit WHERE id=?2)
       RETURNING ${NOTIFICATION_SELECT_COLUMNS}`,
    )
    .bind(messageId, auditId);
}

function prepareStatusWrite(
  db: D1Database,
  payload: ReviewNotificationPayload,
): D1PreparedStatement[] {
  let type: "system.submission.approved" | "system.submission.needs_review" | null = null;
  if (payload.command.decision === "approved") {
    type = "system.submission.approved";
  } else if (payload.command.decision === "pending_audit") {
    type = "system.submission.needs_review";
  }
  if (!type) {
    return [];
  }

  const notificationId = nanoid(18);
  const messageId = nanoid(18);
  const createdAt = payload.transitionedAt;
  const openKey = JSON.stringify([
    "system",
    payload.command.target.userId,
    type,
    payload.command.target.kind,
  ]);
  const eventDedupeKey = [
    "system",
    payload.command.target.id,
    payload.command.target.snapshotId,
    payload.command.expectedReviewStatus,
    payload.command.decision,
  ].join(":");
  const payloadJson = serializePayload(systemPayload(payload.command.target.kind));

  return [
    db
      .prepare(
        `UPDATE notifications
       SET open_aggregation_key = NULL
       WHERE open_aggregation_key = ?1
         AND window_expires_at <= ?2
         AND EXISTS (SELECT 1 FROM ugc_snapshots_review_audit WHERE id=?3)`,
      )
      .bind(openKey, createdAt, payload.command.auditId),
    db
      .prepare(
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
         AND EXISTS (SELECT 1 FROM ugc_snapshots_review_audit a
           WHERE a.id=?10 AND a.snapshot_id=?9)
         AND NOT EXISTS (
           SELECT 1 FROM notification_messages WHERE dedupe_key = ?11
         )
       ON CONFLICT(open_aggregation_key) DO NOTHING`,
      )
      .bind(
        notificationId,
        type,
        payloadJson,
        `group:${notificationId}`,
        createdAt,
        openKey,
        expiresAt(createdAt),
        payload.command.target.id,
        payload.command.target.snapshotId,
        payload.command.auditId,
        eventDedupeKey,
      ),
    db
      .prepare(
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
         AND EXISTS (SELECT 1 FROM ugc_snapshots_review_audit a
           WHERE a.id=?8 AND a.snapshot_id=?7)
         AND ?4 < n.window_expires_at
       ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .bind(
        messageId,
        payloadJson,
        eventDedupeKey,
        createdAt,
        openKey,
        payload.command.target.id,
        payload.command.target.snapshotId,
        payload.command.auditId,
      ),
    appendParentUpdateStatement(db, messageId, payload.command.auditId),
  ];
}

function prepareReplyWrite(
  db: D1Database,
  payload: ReviewNotificationPayload,
): D1PreparedStatement[] {
  if (!payload.command.target.parentId) {
    return [];
  }

  const notificationId = nanoid(18);
  const messageId = nanoid(18);
  const createdAt = payload.transitionedAt;
  const openKey = JSON.stringify(["community", "reply", payload.command.target.parentId]);
  const eventDedupeKey = `reply:${payload.command.target.id}`;
  const payloadJson = serializePayload(communityPayload("comment"));

  return [
    db
      .prepare(
        `UPDATE notifications
       SET open_aggregation_key = NULL
       WHERE open_aggregation_key = ?1
         AND window_expires_at <= ?2
         AND EXISTS (SELECT 1 FROM ugc_snapshots_review_audit WHERE id=?3)`,
      )
      .bind(openKey, createdAt, payload.command.auditId),
    db
      .prepare(
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
         AND EXISTS (SELECT 1 FROM ugc_snapshots_review_audit a
           WHERE a.id=?8 AND a.to_status='approved')
         AND child.kind = 'comment'
         AND parent.kind = 'comment'
         AND parent.user_id <> child.user_id
         AND NOT EXISTS (
           SELECT 1 FROM notification_messages WHERE dedupe_key = ?9
         )
       ON CONFLICT(open_aggregation_key) DO NOTHING`,
      )
      .bind(
        notificationId,
        payloadJson,
        `group:${notificationId}`,
        createdAt,
        openKey,
        expiresAt(createdAt),
        payload.command.target.id,
        payload.command.auditId,
        eventDedupeKey,
      ),
    db
      .prepare(
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
         AND EXISTS (SELECT 1 FROM ugc_snapshots_review_audit a
           WHERE a.id=?7 AND a.to_status='approved')
         AND child.kind = 'comment'
         AND parent.kind = 'comment'
         AND parent.user_id <> child.user_id
         AND ?4 < n.window_expires_at
       ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .bind(
        messageId,
        payloadJson,
        eventDedupeKey,
        createdAt,
        openKey,
        payload.command.target.id,
        payload.command.auditId,
      ),
    appendParentUpdateStatement(db, messageId, payload.command.auditId),
  ];
}

/** Internal repository composition; callers never assemble or index these writes. */
export async function commitReviewBatch(
  db: D1Database,
  command: ReviewCommand,
  statements: D1PreparedStatement[],
  transitionedAt: string,
): Promise<{
  committed: boolean;
  firstApproval: boolean;
  publicReplaced: boolean;
  notifications: NotificationRecord[];
}> {
  const indexes: number[] = [];
  const payload = { command, transitionedAt };
  for (const writes of [
    prepareStatusWrite(db, payload),
    command.decision === "approved" ? prepareReplyWrite(db, payload) : [],
  ]) {
    if (writes.length) {
      indexes.push(statements.length + writes.length - 1);
      statements.push(...writes);
    }
  }
  const results = await db.batch<Record<string, unknown>>(statements);
  return {
    committed: Boolean(results[0].results?.length),
    firstApproval: Boolean(results[3].results?.[0]?.firstApproval),
    publicReplaced: Boolean(results[3].results?.[0]?.publicReplaced),
    notifications: indexes.flatMap((index) => notificationsFromResult(results[index])),
  };
}
