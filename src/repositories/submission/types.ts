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
  moderationNote: string | null;
  moderationQueuedAt: string | null;
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
}

export type SubmissionStatus =
  | "pending_openai"
  | "pending_audit"
  | "active"
  | "flagged"
  | "remove_request"
  | "stale";

export type SubmissionKind = "image" | "comment";

export type SubmissionVoteValue = 1 | -1;
export type ViewerVoteValue = SubmissionVoteValue | 0;

export interface PublicSubmissionImage {
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
  upvoted?: boolean;
  flagged?: boolean;
  createdAt: string;
}

export interface PublicSubmissionComment {
  id: string;
  markerId: string;
  poiHash: string;
  poiType: string;
  parentId: string | null;
  depth: number;
  content: string;
  author: {
    nickname: string;
    publicUid: string;
  } | null;
  status: SubmissionStatus;
  score: number;
  viewerVote?: ViewerVoteValue;
  flagged?: boolean;
  replyCount: number;
  replies: PublicSubmissionComment[];
  createdAt: string;
}

export interface UserSubmissionComment extends Omit<PublicSubmissionComment, "replies" | "replyCount"> {
  snapshotId: string;
  flagCount: number;
  replies?: PublicSubmissionComment[];
  replyCount?: number;
}

export interface CommentTranslationRecord {
  commentId: string;
  sourceLanguage: string;
  detectedSourceLanguage: string | null;
  targetLanguage: string;
  glossaryKey: string;
  sourceHash: string;
  translatedContent: string;
  provider: string;
  glossaryApplied: boolean;
  createdAt: string;
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
  "remove_request",
  "stale"
];
