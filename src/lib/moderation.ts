export const AI_STALE_MODERATION_NOTE_PREFIX = "OpenAI moderation flagged:";
export const AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX = "OpenAI moderation needs audit:";
export const AI_ACTIVE_MODERATION_NOTE_PREFIX = "OpenAI moderation passed:";
export const RECALL_MODERATION_NOTE_PREFIX = "Recalled by uploader:";
export const COMMENT_EDIT_MODERATION_NOTE_PREFIX = "Edited by author:";
export const COMMENT_ADMIN_EDIT_MODERATION_NOTE_PREFIX = "Edited by admin:";

export function isCommentEditModerationNote(note: string | null | undefined): boolean {
  return Boolean(
    note?.startsWith(COMMENT_EDIT_MODERATION_NOTE_PREFIX) ||
    note?.startsWith(COMMENT_ADMIN_EDIT_MODERATION_NOTE_PREFIX)
  );
}
