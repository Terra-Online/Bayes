import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const directory = new URL("../../../migrations/", import.meta.url);
export const migrations = readdirSync(directory)
  .filter((file) => file.endsWith(".sql"))
  .sort();

/** Explicit file lists let historical tests stop and resume at a migration boundary. */
export function applyMigrations(sqlite: DatabaseSync, files: string[] = migrations): void {
  for (const file of files) {
    const sql = readFileSync(new URL(file, directory), "utf8");
    // Earlier migrations toggle foreign_keys outside transactions. The UGC
    // cutover requires deferred references through one actual commit.
    if (file === "0038_ugc_snapshots.sql") {
      sqlite.exec("BEGIN");
      try {
        sqlite.exec(sql);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    } else {
      sqlite.exec(sql);
    }
  }
}
