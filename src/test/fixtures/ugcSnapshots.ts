import { readFileSync } from "node:fs";

import type { TestDatabase } from "@/test/database/createTestDatabase";

export const snapshotImportSql = readFileSync(
  new URL("../../../migration-candidates/ugc-snapshots/import-current.sql", import.meta.url),
  "utf8",
);

/** Only isolated fixtures opt into this destructive, unregistered candidate. */
export function importCurrentSubmissions(database: TestDatabase): void {
  database.sqlite.exec("BEGIN");
  try {
    database.sqlite.exec(snapshotImportSql);
    database.sqlite.exec("COMMIT");
  } catch (error) {
    database.sqlite.exec("ROLLBACK");
    throw error;
  }
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
