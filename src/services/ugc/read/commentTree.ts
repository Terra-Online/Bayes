import type { PublicCommentNode } from "@/repositories/submission/types";

/** Apply per-parent branch limits consistently to cached and uncached trees.
 * Empty hidden branches never take a slot, including when replyLimit is zero.
 * replyCount describes the pruned tree before request-specific limits.
 */
export function selectCommentBranches(
  comments: PublicCommentNode[],
  limit: number,
  replyLimit: number,
): PublicCommentNode[] {
  const selected: PublicCommentNode[] = [];
  for (const comment of comments) {
    if (selected.length >= limit) {
      break;
    }
    const replies = selectCommentBranches(comment.replies, replyLimit, replyLimit);
    if (comment.type === "placeholder" && replies.length === 0) {
      continue;
    }
    selected.push({ ...comment, replies });
  }
  return selected;
}
