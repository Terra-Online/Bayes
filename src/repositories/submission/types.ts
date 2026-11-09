export type SnapshotReviewStatus =
  | "pending_openai"
  | "pending_audit"
  | "approved"
  | "rejected"
  | "unknown";

export interface SubmissionRecord {
  id: string;
  kind: SubmissionKind;
  markerId: string;
  poiHash: string;
  poiType: string;
  snapshotId: string;
  userId: string;
  content: string | null;
  filePath: string | null;
  status: SubmissionStatus;
  flagCount: number;
  mimeType: string | null;
  sizeBytes: number | null;
  parentId: string | null;
  commentDepth: number;
  submitter: SubmissionSubmitter | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionSubmitter {
  uid: string;
  uidNumber: number | null;
  publicUid: string | null;
  role: string | null;
  karma: number | null;
  nickname: string | null;
  avatar: number | null;
}

export type SubmissionStatus = "pending_openai" | "pending_audit" | "active" | "flagged" | "stale";

export type SubmissionKind = "image" | "comment";

export type SubmissionVoteValue = 1 | -1;
export type ViewerVoteValue = SubmissionVoteValue | 0;

export interface PublicSubmissionImage {
  snapshotId: string;
  id: string;
  markerId: string;
  url: string;
  content: string | null;
  author: {
    nickname: string;
    publicUid: string;
  } | null;
  status: SubmissionStatus;
  upvoteCount: number;
  flagCount: number;
  upvoted?: boolean;
  flagged?: boolean;
  createdAt: string;
}

interface CommentStructure {
  id: string;
  markerId: string;
  parentId: string | null;
  depth: number;
  replyCount: number;
  replies: PublicCommentNode[];
}

export interface CommentPlaceholder extends CommentStructure {
  type: "placeholder";
}

export type PublicCommentNode = PublicSubmissionComment | CommentPlaceholder;

export interface PublicSubmissionComment extends CommentStructure {
  type: "comment";
  snapshotId: string;
  poiHash: string;
  poiType: string;
  content: string;
  author: {
    nickname: string;
    publicUid: string;
    avatar?: number;
    karma?: number;
  } | null;
  status: SubmissionStatus;
  score: number;
  viewerVote?: ViewerVoteValue;
  flagged?: boolean;
  createdAt: string;
}

export interface UserSubmissionComment extends Omit<
  PublicSubmissionComment,
  "replies" | "replyCount"
> {
  snapshotId: string;
  flagCount: number;
  replies?: PublicCommentNode[];
  replyCount?: number;
}

export interface TextTranslationRecord {
  cacheKey: string;
  textHash: string;
  flowVersion: string;
  sourceLanguage: string;
  detectedSourceLanguage: string | null;
  targetLanguage: string;
  provider: string;
  glossaryVersion: string;
  glossaryKey: string;
  translatedContent: string;
  glossaryApplied: boolean;
  translatedAt: string;
  updatedAt: string;
}

export interface UserSubmissionImage extends PublicSubmissionImage {
  poiHash: string;
  poiType: string;
  snapshotId: string;
  filePath: string;
  flagCount: number;
  status: SubmissionStatus;
}

export const ALL_STATUSES: SubmissionStatus[] = [
  "pending_openai",
  "pending_audit",
  "active",
  "flagged",
  "stale",
];
