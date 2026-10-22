import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const directory = new URL("../../../migrations/", import.meta.url);
export const migrations = readdirSync(directory)
  .filter((file) => file.endsWith(".sql"))
  .sort();

/** Explicit file lists let historical tests stop and resume at a migration boundary. */
export function applyMigrations(sqlite: DatabaseSync, files: string[] = migrations): void {
  for (const file of files) {
    sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
  }
}
