import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";

import { authSchemaDatabase } from "./schemaMetadata";

describe("validated D1 metadata isolation", () => {
  const databases: TestDatabase[] = [];
  afterEach(() => databases.splice(0).forEach((database) => database.close()));
  function setup() {
    const database = createTestDatabase();
    databases.push(database);
    database.sqlite.exec(
      "INSERT INTO auth_users (id, name, email) VALUES ('user', 'First', 'first@example.test')",
    );
    return database;
  }

  it("shares only plain completed schema results, without exposing mutable cached rows", async () => {
    const database = setup();
    const cold = authSchemaDatabase(database.db);
    const result = await cold.db
      .prepare("SELECT * FROM pragma_table_info(?)")
      .bind("auth_users")
      .all();
    const warm = authSchemaDatabase(database.db, new Map(cold.metadata));
    result.results[0]!.name = "mutated-by-caller";
    const cached = await warm.db
      .prepare("SELECT * FROM pragma_table_info(?)")
      .bind("auth_users")
      .all();
    expect(cached.results[0]!.name).toBe("id");
    cached.results[0]!.name = "another-mutation";
    expect(
      (await warm.db.prepare("SELECT * FROM pragma_table_info(?)").bind("auth_users").all())
        .results[0]!.name,
    ).toBe("id");
    expect(database.queries).toHaveLength(1);
    expect(cached.meta.rows_read).toBe(0);
  });

  it("uses native business statements without preparing them again on bind", async () => {
    const database = setup();
    const prepare = vi.spyOn(database.db, "prepare");
    const wrapped = authSchemaDatabase(database.db);
    const statement = wrapped.db.prepare("SELECT name FROM auth_users WHERE id = ?1");
    expect(statement).toBe(prepare.mock.results[0]!.value);
    await statement.bind("user").first();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("always sends business queries and mixed atomic batches to D1", async () => {
    const database = setup();
    const cold = authSchemaDatabase(database.db);
    await cold.db.prepare("SELECT * FROM pragma_table_info(?)").bind("auth_users").all();
    const warm = authSchemaDatabase(database.db, new Map(cold.metadata));
    const query = "SELECT name FROM auth_users WHERE id = ?1";
    expect(await warm.db.prepare(query).bind("user").first("name")).toBe("First");
    database.sqlite.exec("UPDATE auth_users SET name = 'Changed' WHERE id = 'user'");
    const result = await warm.db.batch([
      warm.db.prepare("SELECT * FROM pragma_table_info(?)").bind("auth_users"),
      warm.db.prepare(query).bind("user"),
    ]);
    expect(result[1]!.results).toMatchObject([{ name: "Changed" }]);
    expect(database.queries.filter(({ sql }) => sql === query)).toHaveLength(2);
    expect(database.queries.filter(({ sql }) => /pragma_table_info/.test(sql))).toHaveLength(2);
  });
});
