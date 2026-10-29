import { readFileSync } from "node:fs";

import type { TestDatabase } from "@/test/database/createTestDatabase";
import { applyMigrations } from "@/test/database/migrations";

export const snapshotImportSql = readFileSync(
  new URL("../../../migrations/0038_ugc_snapshots.sql", import.meta.url),
  "utf8",
);

/** Historical fixtures apply the registered cutover exactly once. */
export function importCurrentSubmissions(database: TestDatabase): void {
  applyMigrations(database.sqlite, ["0038_ugc_snapshots.sql"]);
}

export const legacySnapshotSeedSql = readFileSync(
  new URL("./ugcSnapshotLegacy.sql", import.meta.url),
  "utf8",
);

export const retainedUgcTables = [
  "ugc_submission_upvotes",
  "ugc_submission_votes",
  "ugc_submission_flags",
  "notifications",
  "notification_messages",
  "notification_counters",
] as const;
