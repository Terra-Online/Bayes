import type { SubmissionKind } from "./types";

interface DeleteInput {
  submissionId: string;
  kind: SubmissionKind;
  authorId: string;
}

interface DeletedSubmission {
  markerId: string;
  authorDeletedAt: string;
}

export type AuthorDeletionResult =
  | { outcome: "not_found" }
  | { outcome: "unauthorized" }
  | ({ outcome: "deleted" | "already_deleted" } & DeletedSubmission);

/** Ownership and the first deletion fact are checked together, independently of review/disable. */
export async function deleteByAuthor(
  db: D1Database,
  input: DeleteInput,
): Promise<AuthorDeletionResult> {
  const results = await db.batch([
    db
      .prepare(`UPDATE ugc_submissions
      SET author_deleted_at = ?4, updated_at = ?4
      WHERE id = ?1 AND kind = ?2 AND user_id = ?3 AND author_deleted_at IS NULL
      RETURNING poi_id AS markerId, author_deleted_at AS authorDeletedAt`)
      .bind(input.submissionId, input.kind, input.authorId, new Date().toISOString()),
    db
      .prepare(`SELECT user_id AS authorId, poi_id AS markerId,
      author_deleted_at AS authorDeletedAt FROM ugc_submissions WHERE id = ?1 AND kind = ?2`)
      .bind(input.submissionId, input.kind),
  ]);
  const changed = results[0].results[0] as DeletedSubmission | undefined;
  if (changed) {
    return { outcome: "deleted", ...changed };
  }
  const existing = results[1].results[0] as (DeletedSubmission & { authorId: string }) | undefined;
  if (!existing) {
    return { outcome: "not_found" };
  }
  if (existing.authorId !== input.authorId) {
    return { outcome: "unauthorized" };
  }
  return {
    outcome: "already_deleted",
    markerId: existing.markerId,
    authorDeletedAt: existing.authorDeletedAt,
  };
}
