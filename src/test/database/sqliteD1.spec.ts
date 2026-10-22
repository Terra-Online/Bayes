import { afterEach, beforeEach, expect, it } from "vitest";

import { SqliteD1 } from "./sqliteD1";

let database: SqliteD1;

beforeEach(() => {
  database = new SqliteD1();
  database.sqlite.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
});

afterEach(() => database.close());

it("binds anonymous and numbered parameters and reads a selected column", async () => {
  await database.db.prepare("INSERT INTO accounts VALUES (?, ?)").bind("user", "First").run();

  expect(
    await database.db.prepare("SELECT name FROM accounts WHERE id = ?1").bind("user").first("name"),
  ).toBe("First");
});

it("rolls back earlier writes when a later batch statement fails, then allows a retry", async () => {
  const statements = [
    database.db.prepare("INSERT INTO accounts VALUES (?1, ?2)").bind("user", "First"),
    database.db.prepare("INSERT INTO accounts VALUES (?1, ?2)").bind("user", "Duplicate"),
  ];
  await expect(database.db.batch(statements)).rejects.toThrow("UNIQUE");
  expect(await database.db.prepare("SELECT * FROM accounts").all()).toMatchObject({ results: [] });
  await database.db.batch([statements[0]!]);
  expect(await database.db.prepare("SELECT * FROM accounts").raw()).toEqual([["user", "First"]]);
});
