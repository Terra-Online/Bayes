import type { DatabaseSync } from "node:sqlite";

import { insertSubmission } from "./submissions";
import { insertUser } from "./users";

/** Existing image-read scenario, shared by repository and HTTP regression tests. */
export function seedImageReadScenario(sqlite: DatabaseSync): void {
  insertUser(sqlite, { uid: "author", uid_number: 123, uid_suffix: "abcd", nickname: "Author" });
  for (const uid of ["viewer", "other", "inactive"]) {
    insertUser(sqlite, { uid });
  }
  for (const [id, filePath, createdAt] of [
    ["photo", "images/photo.webp", "2026-09-01"],
    ["test-photo", "_test/photo.webp", "2026-09-02"],
    ["mine", "images/mine.webp", "2026-09-03"],
  ]) {
    insertSubmission(sqlite, {
      id,
      userId: "author",
      kind: "image",
      markerId: "42",
      poiType: "sample",
      snapshotId: id === "photo" ? "current" : `snapshot-${id}`,
      content: id === "photo" ? "Caption" : null,
      filePath,
      createdAt,
      updatedAt: "2026-09-05T12:00:00Z",
    });
  }
  sqlite.exec(`INSERT INTO ugc_submission_upvotes (submission_id, user_id, active)
    VALUES ('photo', 'viewer', 1), ('photo', 'other', 1), ('photo', 'inactive', 0);
    INSERT INTO ugc_submission_flags (submission_id, user_id, active)
    VALUES ('photo', 'viewer', 1), ('photo', 'inactive', 0);`);
}
