import type { CollectionPosition, InboxDelivery } from "@/services/notify/contract/events";

import { mapNotification, type NotificationRecord } from "./notifications";

/** A losing collector cannot insert rows or advance the winner's position. */
export async function commitCollection(
  db: D1Database,
  userId: string,
  position: CollectionPosition,
  next: number,
  deliveries: InboxDelivery[],
  now: string,
): Promise<{ committed: boolean; notifications: NotificationRecord[] }> {
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(`INSERT INTO notification_collection_progress(user_id,source_kind,last_event_sequence,updated_at)
      SELECT ?1,source_kind,cutover_sequence,?3 FROM notification_sources WHERE source_kind=?2
      ON CONFLICT(user_id,source_kind) DO NOTHING`)
      .bind(userId, position.source, now),
    db
      .prepare(`INSERT INTO notifications
      (id,recipient_user_id,category,type,actor_user_id,submission_id,parent_submission_id,
       marker_id,poi_hash,poi_type,payload_json,dedupe_key,created_at,projected_at,source_kind,source_event_id,purpose)
      SELECT json_extract(value,'$.id'),?1,json_extract(value,'$.category'),json_extract(value,'$.type'),
       json_extract(value,'$.actorUserId'),json_extract(value,'$.submissionId'),json_extract(value,'$.parentSubmissionId'),
       json_extract(value,'$.markerId'),json_extract(value,'$.poiHash'),json_extract(value,'$.poiType'),
       json_extract(value,'$.payload'),json_extract(value,'$.dedupeKey'),json_extract(value,'$.createdAt'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       ?2,json_extract(value,'$.eventId'),json_extract(value,'$.purpose')
      FROM json_each(?4) WHERE EXISTS (SELECT 1 FROM notification_collection_progress
        WHERE user_id=?1 AND source_kind=?2 AND last_event_sequence=?3)
      ON CONFLICT DO NOTHING RETURNING *`)
      .bind(userId, position.source, position.after, JSON.stringify(deliveries)),
    db
      .prepare(`UPDATE notification_collection_progress SET last_event_sequence=?4,updated_at=?5
      WHERE user_id=?1 AND source_kind=?2 AND last_event_sequence=?3 RETURNING user_id`)
      .bind(userId, position.source, position.after, next, now),
  ]);
  return {
    committed: results[2].results.length > 0,
    notifications: results[1].results.map(mapNotification),
  };
}
