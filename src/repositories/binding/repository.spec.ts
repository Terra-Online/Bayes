import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertUser } from "@/test/fixtures/users";

import { saveBinding } from "./repository";

let database: TestDatabase;
const role = {
  serverId: 1,
  roleId: "role",
  nickname: "name",
  serverName: "server",
  serverType: "test",
  level: 1,
  isDefault: true,
};
beforeEach(() => {
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "user" });
});
afterEach(() => database.close());

it("reports a schema error rather than persisting an incomplete binding", async () => {
  database.sqlite.exec("ALTER TABLE endfield_bindings DROP COLUMN account_token_enc");
  await expect(
    saveBinding(database.db, "user", "skland", role, {
      cred: "cred",
      token: "token",
      accountToken: "account",
    }),
  ).rejects.toThrow("account_token_enc");
  expect(
    database.sqlite.prepare("SELECT COUNT(*) AS count FROM endfield_bindings").get()!.count,
  ).toBe(0);
});
