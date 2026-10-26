import {
  listCommentViewerStateByMarker,
  type CommentViewerReaction,
} from "@/repositories/submission/listComments";
import {
  listImageViewerReactionsByMarker,
  type ImageViewerReaction,
} from "@/repositories/submission/listImages";
import type {
  PublicSubmissionComment,
  PublicSubmissionImage,
  UserSubmissionComment,
} from "@/repositories/submission/types";
import type { ImageReadScope } from "@/services/ugc/contract/imageScope";

export async function readCommentViewerFeed(
  db: D1Database,
  input: {
    markerIds: string[];
    viewerUserId: string;
    publicComments: PublicSubmissionComment[];
  },
): Promise<PublicSubmissionComment[]> {
  const submissionIds: string[] = [];
  const collectIds = (comments: PublicSubmissionComment[]): void => {
    for (const comment of comments) {
      submissionIds.push(comment.id);
      collectIds(comment.replies);
    }
  };
  collectIds(input.publicComments);
  const state = await listCommentViewerStateByMarker(db, {
    userId: input.viewerUserId,
    markerIds: input.markerIds,
    submissionIds,
    pendingLimit: 200,
  });
  const comments = applyCommentViewerReactions(input.publicComments, state.reactions);
  return mergeViewerPendingComments(comments, state.pendingComments);
}
export async function readImageViewerFeed(
  db: D1Database,
  input: {
    markerIds: string[];
    viewerUserId: string;
    publicImages: PublicSubmissionImage[];
    scope: ImageReadScope;
  },
): Promise<PublicSubmissionImage[]> {
  const reactions = await listImageViewerReactionsByMarker(db, {
    userId: input.viewerUserId,
    markerIds: input.markerIds,
    submissionIds: input.publicImages.map((item) => item.id),
    ...input.scope,
  });
  return applyImageViewerReactions(input.publicImages, reactions);
}

function applyCommentViewerReactions(
  comments: PublicSubmissionComment[],
  reactions: Map<string, CommentViewerReaction>,
): PublicSubmissionComment[] {
  return comments.map((comment) => {
    const reaction = reactions.get(comment.id);
    return {
      ...comment,
      viewerVote: reaction?.viewerVote ?? 0,
      flagged: reaction?.flagged ?? false,
      replies: applyCommentViewerReactions(comment.replies, reactions),
    };
  });
}

function mergeViewerPendingComments(
  publicComments: PublicSubmissionComment[],
  viewerComments: UserSubmissionComment[],
): PublicSubmissionComment[] {
  const commentById = new Map<string, PublicSubmissionComment>();
  const indexTree = (comments: PublicSubmissionComment[]): void => {
    comments.forEach((comment) => {
      commentById.set(comment.id, comment);
      indexTree(comment.replies);
    });
  };
  indexTree(publicComments);

  const pendingRoots: PublicSubmissionComment[] = [];
  const pending = viewerComments
    .filter((comment) => comment.status === "pending_openai" || comment.status === "pending_audit")
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    );

  pending.forEach((comment) => {
    if (commentById.has(comment.id)) {
      return;
    }

    const normalized: PublicSubmissionComment = {
      ...comment,
      replyCount: comment.replyCount ?? 0,
      replies: comment.replies ?? [],
    };
    const parent = normalized.parentId ? commentById.get(normalized.parentId) : undefined;
    if (parent) {
      parent.replies.push(normalized);
      parent.replyCount += 1;
    } else {
      pendingRoots.push(normalized);
    }
    commentById.set(normalized.id, normalized);
  });

  return pendingRoots.length > 0 ? [...pendingRoots, ...publicComments] : publicComments;
}
function applyImageViewerReactions(
  images: PublicSubmissionImage[],
  reactions: Map<string, ImageViewerReaction>,
): PublicSubmissionImage[] {
  return images.map((image) => {
    const reaction = reactions.get(image.id);
    return {
      ...image,
      upvoted: reaction?.upvoted ?? false,
      flagged: reaction?.flagged ?? false,
    };
  });
}
