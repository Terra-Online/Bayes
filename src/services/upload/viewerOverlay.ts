import type { CommentViewerReaction } from "../../repositories/submission/listComments";
import type { ImageViewerReaction } from "../../repositories/submission/listImages";
import type {
  PublicSubmissionComment,
  PublicSubmissionImage
} from "../../repositories/submission/types";

export function applyCommentViewerReactions(
  comments: PublicSubmissionComment[],
  reactions: Map<string, CommentViewerReaction>
): PublicSubmissionComment[] {
  return comments.map((comment) => {
    const reaction = reactions.get(comment.id);
    return {
      ...comment,
      viewerVote: reaction?.viewerVote ?? 0,
      flagged: reaction?.flagged ?? false,
      replies: applyCommentViewerReactions(comment.replies, reactions)
    };
  });
}

export function applyImageViewerReactions(
  images: PublicSubmissionImage[],
  reactions: Map<string, ImageViewerReaction>
): PublicSubmissionImage[] {
  return images.map((image) => {
    const reaction = reactions.get(image.id);
    return {
      ...image,
      upvoted: reaction?.upvoted ?? false,
      flagged: reaction?.flagged ?? false
    };
  });
}
