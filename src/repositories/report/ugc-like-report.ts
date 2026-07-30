import { buildPointShareUrlForMarker } from "../../lib/pointShare";

export interface UgcLikeReport {
  generatedAt: string;
  totalLikes: number;
  imageLikes: number;
  commentLikes: number;
  commentDislikes: number;
  uniqueReactors: number;
  likedSubmissions: number;
  firstReactionDate: string | null;
  lastReactionDate: string | null;
  topImage: {
    id: string;
    markerId: string;
    poiType: string;
    filePath: string;
    likeCount: number;
    createdAt: string;
    pointUrl: string;
  } | null;
  daily: Array<{
    date: string;
    imageLikes: number;
    commentLikes: number;
    commentDislikes: number;
  }>;
  contributorLikes: Array<{
    userId: string;
    likeCount: number;
  }>;
}

type CountValue = number | string | null | undefined;

function toCount(value: CountValue): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

const REACTION_EVENTS_CTE = `WITH reaction_events AS (
  SELECT
    upvotes.submission_id,
    upvotes.user_id,
    upvotes.created_at,
    'image' AS kind,
    1 AS value
  FROM ugc_submission_upvotes AS upvotes
  INNER JOIN ugc_submissions AS submissions
    ON submissions.id = upvotes.submission_id
   AND submissions.kind = 'image'
  WHERE upvotes.active = 1

  UNION ALL

  SELECT
    votes.submission_id,
    votes.user_id,
    votes.created_at,
    'comment' AS kind,
    votes.value
  FROM ugc_submission_votes AS votes
  INNER JOIN ugc_submissions AS submissions
    ON submissions.id = votes.submission_id
   AND submissions.kind = 'comment'
  WHERE votes.active = 1
)`;

export async function getUgcLikeReport(db: D1Database): Promise<UgcLikeReport> {
  const [summary, dailyRows, topImageRow, contributorLikeRows] = await Promise.all([
    db
      .prepare(
        `${REACTION_EVENTS_CTE}
         SELECT
           SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS total_likes,
           SUM(CASE WHEN kind = 'image' AND value = 1 THEN 1 ELSE 0 END) AS image_likes,
           SUM(CASE WHEN kind = 'comment' AND value = 1 THEN 1 ELSE 0 END) AS comment_likes,
           SUM(CASE WHEN kind = 'comment' AND value = -1 THEN 1 ELSE 0 END) AS comment_dislikes,
           COUNT(DISTINCT user_id) AS unique_reactors,
           COUNT(DISTINCT CASE WHEN value = 1 THEN submission_id END) AS liked_submissions,
           MIN(date(created_at)) AS first_reaction_date,
           MAX(date(created_at)) AS last_reaction_date
         FROM reaction_events`,
      )
      .first<{
        total_likes: CountValue;
        image_likes: CountValue;
        comment_likes: CountValue;
        comment_dislikes: CountValue;
        unique_reactors: CountValue;
        liked_submissions: CountValue;
        first_reaction_date: string | null;
        last_reaction_date: string | null;
      }>(),
    db
      .prepare(
        `${REACTION_EVENTS_CTE}
         SELECT
           date(created_at) AS reaction_date,
           SUM(CASE WHEN kind = 'image' AND value = 1 THEN 1 ELSE 0 END) AS image_likes,
           SUM(CASE WHEN kind = 'comment' AND value = 1 THEN 1 ELSE 0 END) AS comment_likes,
           SUM(CASE WHEN kind = 'comment' AND value = -1 THEN 1 ELSE 0 END) AS comment_dislikes
         FROM reaction_events
         WHERE date(created_at) IS NOT NULL
         GROUP BY date(created_at)
         ORDER BY reaction_date ASC`,
      )
      .all<{
        reaction_date: string;
        image_likes: CountValue;
        comment_likes: CountValue;
        comment_dislikes: CountValue;
      }>(),
    db
      .prepare(
        `SELECT
           submissions.id,
           submissions.poi_id,
           submissions.poi_type,
           submissions.file_path,
           submissions.created_at,
           COUNT(*) AS like_count
         FROM ugc_submission_upvotes AS upvotes
         INNER JOIN ugc_submissions AS submissions
           ON submissions.id = upvotes.submission_id
         WHERE upvotes.active = 1
           AND submissions.kind = 'image'
           AND submissions.status = 'active'
           AND submissions.file_path IS NOT NULL
         GROUP BY submissions.id
         ORDER BY like_count DESC, submissions.created_at DESC, submissions.id DESC
         LIMIT 1`,
      )
      .first<{
        id: string;
        poi_id: string;
        poi_type: string;
        file_path: string;
        created_at: string;
        like_count: CountValue;
      }>(),
    db
      .prepare(
        `SELECT
           contributor_user_id,
           SUM(like_count) AS like_count
         FROM (
           SELECT
             submissions.user_id AS contributor_user_id,
             COUNT(*) AS like_count
           FROM ugc_submission_upvotes AS upvotes
           INNER JOIN ugc_submissions AS submissions
             ON submissions.id = upvotes.submission_id
            AND submissions.kind = 'image'
           WHERE upvotes.active = 1
           GROUP BY submissions.user_id

           UNION ALL

           SELECT
             submissions.user_id AS contributor_user_id,
             COUNT(*) AS like_count
           FROM ugc_submission_votes AS votes
           INNER JOIN ugc_submissions AS submissions
             ON submissions.id = votes.submission_id
            AND submissions.kind = 'comment'
           WHERE votes.active = 1
             AND votes.value = 1
           GROUP BY submissions.user_id
         ) AS contributor_reactions
         GROUP BY contributor_user_id
         ORDER BY like_count DESC, contributor_user_id ASC`,
      )
      .all<{
        contributor_user_id: string;
        like_count: CountValue;
      }>(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    totalLikes: toCount(summary?.total_likes),
    imageLikes: toCount(summary?.image_likes),
    commentLikes: toCount(summary?.comment_likes),
    commentDislikes: toCount(summary?.comment_dislikes),
    uniqueReactors: toCount(summary?.unique_reactors),
    likedSubmissions: toCount(summary?.liked_submissions),
    firstReactionDate: summary?.first_reaction_date ?? null,
    lastReactionDate: summary?.last_reaction_date ?? null,
    topImage: topImageRow
      ? {
          id: String(topImageRow.id),
          markerId: String(topImageRow.poi_id),
          poiType: String(topImageRow.poi_type),
          filePath: String(topImageRow.file_path),
          likeCount: toCount(topImageRow.like_count),
          createdAt: String(topImageRow.created_at),
          pointUrl: buildPointShareUrlForMarker(
            String(topImageRow.poi_id),
            String(topImageRow.poi_type),
          ),
        }
      : null,
    daily: (dailyRows.results ?? []).map((row) => ({
      date: String(row.reaction_date),
      imageLikes: toCount(row.image_likes),
      commentLikes: toCount(row.comment_likes),
      commentDislikes: toCount(row.comment_dislikes),
    })),
    contributorLikes: (contributorLikeRows.results ?? []).map((row) => ({
      userId: String(row.contributor_user_id),
      likeCount: toCount(row.like_count),
    })),
  };
}
