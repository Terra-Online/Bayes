import { applyMigrations, migrations } from "./migrations";
import { SqliteD1 } from "./sqliteD1";

export function createTestDatabase(files: string[] = migrations): SqliteD1 {
  const database = new SqliteD1();
  try {
    applyMigrations(database.sqlite, files);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
