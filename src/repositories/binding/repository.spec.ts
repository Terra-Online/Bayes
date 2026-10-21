import { afterEach, beforeEach, expect, it } from "vitest";

import { SqliteD1 } from "@/test/sqliteD1";

import { getBinding, saveBinding } from "./repository";

let database: SqliteD1;
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
  database = new SqliteD1();
  database.sqlite.exec(`CREATE TABLE endfield_bindings (
    uid TEXT PRIMARY KEY, provider TEXT, server_id INTEGER, role_id TEXT, role_nickname TEXT,
    server_name TEXT, cred_enc TEXT, token_enc TEXT, account_token_enc TEXT, status TEXT, updated_at TEXT
  )`);
});
afterEach(() => database.sqlite.close());

it("preserves the account token when creating and replacing a binding", async () => {
  await saveBinding(database.db, "user", "skland", role, {
    cred: "cred",
    token: "token",
    accountToken: "account",
  });
  expect(await getBinding(database.db, "user")).toMatchObject({
    cred_enc: "cred",
    token_enc: "token",
    account_token_enc: "account",
  });
  await saveBinding(database.db, "user", "skport", role, {
    cred: "new-cred",
    token: "new-token",
    accountToken: "new-account",
  });
  expect(await getBinding(database.db, "user")).toMatchObject({
    provider: "skport",
    token_enc: "new-token",
    account_token_enc: "new-account",
  });
});

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
