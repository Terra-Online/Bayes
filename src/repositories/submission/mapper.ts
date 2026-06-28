import { formatPublicUid } from "../users";
import type {
  CommentTranslationRecord,
  PublicSubmissionComment,
  PublicSubmissionImage,
  SubmissionKind,
  SubmissionRecord,
  SubmissionStatus,
  UserSubmissionComment,
  ViewerVoteValue
} from "./types";

export function toCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export function imageStatusListSql(statuses: SubmissionStatus[]): string {
  return statuses.map((status) => `'${status}'`).join(", ");
}

export function mapKind(value: unknown): SubmissionKind {
  return value === "comment" ? "comment" : "image";
}

export function mapStatus(value: unknown): SubmissionStatus {
  if (
    value === "pending_openai" ||
    value === "pending_audit" ||
    value === "active" ||
    value === "flagged" ||
    value === "remove_request" ||
    value === "stale"
  ) {
    return value;
  }
  return "pending_openai";
}

export function mapSubmission(row: Record<string, unknown>): SubmissionRecord {
  const uidNumber = row.user_uid_number === null || row.user_uid_number === undefined
    ? null
    : Number(row.user_uid_number);
  const uidSuffix = row.user_uid_suffix === null || row.user_uid_suffix === undefined
    ? null
    : String(row.user_uid_suffix);
  const submitterUid = row.submitter_uid === null || row.submitter_uid === undefined
    ? null
    : String(row.submitter_uid);

  return {
    id: String(row.id),
    kind: mapKind(row.kind),
    markerId: String(row.poi_id),
    poiHash: String(row.poi_hash),
    poiType: String(row.poi_type),
    snapshotId: String(row.snapshot_id),
    userId: String(row.user_id),
    content: row.content === null ? null : String(row.content ?? ""),
    filePath: row.file_path === null || row.file_path === undefined ? null : String(row.file_path),
    status: mapStatus(row.status),
    moderationNote: row.moderation_note === null ? null : String(row.moderation_note ?? ""),
    mimeType: row.mime_type === null || row.mime_type === undefined ? null : String(row.mime_type),
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    commentDepth: toCount(row.comment_depth),
    submitter: submitterUid
      ? {
          uid: submitterUid,
          uidNumber: uidNumber !== null && Number.isFinite(uidNumber) ? uidNumber : null,
          publicUid: uidNumber !== null && Number.isFinite(uidNumber) && uidSuffix
            ? formatPublicUid(uidNumber, uidSuffix)
            : null,
          role: row.user_role === null || row.user_role === undefined ? null : String(row.user_role),
          karma: row.user_karma === null || row.user_karma === undefined ? null : Number(row.user_karma),
          nickname: row.user_nickname === null || row.user_nickname === undefined ? null : String(row.user_nickname)
        }
      : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function mapVoteValue(value: unknown): ViewerVoteValue {
  const numeric = Number(value ?? 0);
  if (numeric === 1) return 1;
  if (numeric === -1) return -1;
  return 0;
}

export function publicImageFromRow(
  row: Record<string, unknown>,
  assetBaseUrl: string,
  viewerUserId?: string
): PublicSubmissionImage {
  const submission = mapSubmission(row);
  const filePath = submission.filePath ?? "";
  return {
    id: submission.id,
    markerId: submission.markerId,
    url: `${assetBaseUrl}/${filePath}`,
    content: submission.content,
    author: submission.submitter?.publicUid && submission.submitter.nickname
      ? {
          nickname: submission.submitter.nickname,
          publicUid: submission.submitter.publicUid
        }
      : null,
    status: submission.status,
    upvoteCount: toCount(row.upvote_count),
    upvoted: viewerUserId ? Boolean(row.viewer_upvoted) : undefined,
    flagged: viewerUserId ? Boolean(row.viewer_flagged) : undefined,
    createdAt: submission.createdAt
  };
}

export function publicCommentFromRow(
  row: Record<string, unknown>,
  viewerUserId?: string
): PublicSubmissionComment {
  const submission = mapSubmission(row);
  return {
    id: submission.id,
    markerId: submission.markerId,
    poiHash: submission.poiHash,
    poiType: submission.poiType,
    parentId: submission.parentId,
    depth: submission.commentDepth,
    content: submission.content ?? "",
    author: submission.submitter?.publicUid && submission.submitter.nickname
      ? {
          nickname: submission.submitter.nickname,
          publicUid: submission.submitter.publicUid
        }
      : null,
    status: submission.status,
    score: Number(row.score ?? 0) || 0,
    viewerVote: viewerUserId ? mapVoteValue(row.viewer_vote) : undefined,
    flagged: viewerUserId ? Boolean(row.viewer_flagged) : undefined,
    replyCount: toCount(row.reply_count),
    replies: [],
    createdAt: submission.createdAt
  };
}

export function userCommentFromRow(row: Record<string, unknown>): UserSubmissionComment {
  const comment = publicCommentFromRow(row);
  const submission = mapSubmission(row);
  return {
    ...comment,
    snapshotId: submission.snapshotId,
    flagCount: toCount(row.flag_count),
    replies: undefined,
    replyCount: undefined
  };
}

export function mapCommentTranslation(row: Record<string, unknown>): CommentTranslationRecord {
  return {
    commentId: String(row.comment_id),
    sourceLanguage: String(row.source_language),
    detectedSourceLanguage: row.detected_source_language === null || row.detected_source_language === undefined
      ? null
      : String(row.detected_source_language),
    targetLanguage: String(row.target_language),
    glossaryKey: String(row.glossary_key ?? ""),
    sourceHash: String(row.source_hash),
    translatedContent: String(row.translated_content ?? ""),
    provider: String(row.provider ?? "google_cloud_translation_v3"),
    glossaryApplied: Boolean(row.glossary_applied),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
