import type {
  CollectionPosition,
  NotificationFact,
  EventSource,
} from "@/services/notify/contract/events";
import type { UgcEventReference } from "@/services/ugc/contract/events";

const sources: EventSource[] = ["review", "vote"];
const tables = { review: "ugc_snapshots_review_audit", vote: "ugc_vote_events" } as const;

/** Source heads and recipient positions are captured in one read transaction. */
export async function getCollectionPositions(
  db: D1Database,
  userId: string,
): Promise<CollectionPosition[]> {
  const result = await db.batch<{ after: number; upper: number; enabledFrom: string }>(
    sources.map((source) =>
      db
        .prepare(`SELECT COALESCE(p.last_event_sequence,s.cutover_sequence) AS after,
      (SELECT COALESCE(MAX(event_sequence),0) FROM ${tables[source]}) AS upper,
      s.enabled_from AS enabledFrom
      FROM notification_sources s LEFT JOIN notification_collection_progress p
        ON p.source_kind=s.source_kind AND p.user_id=?1 WHERE s.source_kind=?2`)
        .bind(userId, source),
    ),
  );
  return sources.map((source, index) => ({ source, ...result[index].results[0] }));
}

const target = `s.user_id AS ownerId,parent.user_id AS parentOwnerId,s.user_id AS actorId,
  s.kind,s.id AS submissionId,s.parent_id AS parentId,s.poi_id AS markerId,
  s.poi_hash AS poiHash,s.poi_type AS poiType`;

function prepareFacts(
  db: D1Database,
  userId: string,
  position: CollectionPosition,
  since: string,
  through: string,
  limit: number,
): D1PreparedStatement {
  const review = position.source === "review";
  const query = review
    ? `SELECT a.event_sequence AS sequence,a.id,a.snapshot_id AS snapshotId,
        a.from_status AS previous,a.to_status AS next,a.operation_kind AS operation,
        a.first_publication AS firstPublication,a.created_at AS createdAt,${target}
       FROM ugc_snapshots_review_audit a JOIN ugc_snapshots f ON f.id=a.snapshot_id
       JOIN ugc_submissions s ON s.id=f.submission_id
       LEFT JOIN ugc_submissions parent ON parent.id=s.parent_id
       WHERE (s.user_id=?1 OR parent.user_id=?1)`
    : `SELECT a.event_sequence AS sequence,a.id,NULL AS snapshotId,
        CAST(a.previous_value AS TEXT) AS previous,CAST(a.next_value AS TEXT) AS next,
        'vote' AS operation,0 AS firstPublication,a.created_at AS createdAt,
        s.user_id AS ownerId,NULL AS parentOwnerId,a.actor_user_id AS actorId,
        s.kind,s.id AS submissionId,s.parent_id AS parentId,s.poi_id AS markerId,
        s.poi_hash AS poiHash,s.poi_type AS poiType
       FROM ugc_vote_events a JOIN ugc_submissions s ON s.id=a.submission_id
       WHERE s.user_id=?1`;
  return db
    .prepare(`${query}
      AND a.event_sequence>?2 AND a.event_sequence<=?3 AND a.created_at>=?4 AND a.created_at<=?5
      ORDER BY a.event_sequence LIMIT ?6`)
    .bind(userId, position.after, position.upper, since, through, limit);
}

/** Read the user's finite source set in one round trip. */
export async function readNotificationFacts(
  db: D1Database,
  userId: string,
  positions: CollectionPosition[],
  cutoff: string,
  through: string,
  limit: number,
): Promise<NotificationFact[][]> {
  if (positions.length === 0) {
    return [];
  }
  const results = await db.batch<Omit<NotificationFact, "source">>(
    positions.map((position) =>
      prepareFacts(
        db,
        userId,
        position,
        position.enabledFrom > cutoff ? position.enabledFrom : cutoff,
        through,
        limit,
      ),
    ),
  );
  return results.map((result, index) =>
    result.results.map((row) => ({ ...row, source: positions[index].source })),
  );
}

/** Resolve recipients from the fact, even when today's policy suppresses its delivery. */
export async function getEventUsers(db: D1Database, event: UgcEventReference): Promise<string[]> {
  const sql =
    event.source === "review"
      ? `SELECT s.user_id AS owner,parent.user_id AS parent FROM ugc_snapshots_review_audit a
       JOIN ugc_snapshots f ON f.id=a.snapshot_id JOIN ugc_submissions s ON s.id=f.submission_id
       LEFT JOIN ugc_submissions parent ON parent.id=s.parent_id WHERE a.id=?1`
      : `SELECT s.user_id AS owner,NULL AS parent FROM ugc_vote_events a
       JOIN ugc_submissions s ON s.id=a.submission_id WHERE a.id=?1`;
  const row = await db
    .prepare(sql)
    .bind(event.eventId)
    .first<{ owner: string; parent: string | null }>();
  return row
    ? [...new Set([row.owner, row.parent].filter((value): value is string => value !== null))]
    : [];
}
