import type { DatabaseSync } from "node:sqlite";

export function insertNotification(
  sqlite: DatabaseSync,
  input: {
    id: string;
    recipientUserId: string;
    category?: "system" | "community";
    type?: string;
    createdAt?: string;
  },
) {
  sqlite
    .prepare(`INSERT INTO notifications
    (id, recipient_user_id, category, type, dedupe_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.recipientUserId,
      input.category ?? "system",
      input.type ?? "system.submission.approved",
      input.id,
      input.createdAt ?? "2026-09-01T00:00:00.000Z",
    );
  return { id: input.id };
}
