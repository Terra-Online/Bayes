import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  createEndfieldDeviceProfile,
  serializeEndfieldDeviceProfile,
  SKLAND_DEVICE_PROFILE_USER_AGENT,
} from "@/lib/endfieldClient/deviceProfile";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertUser } from "@/test/fixtures/users";

import { getBindingWithDeviceProfile, saveBinding } from "./repository";

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
afterEach(() => {
  database.close();
  vi.unstubAllGlobals();
});

it("keeps a historical binding usable during fingerprint outage and saves its replacement profile for reuse", async () => {
  await saveBinding(database.db, "user", "skland", role, {
    cred: "stored-credential",
    token: "stored-token",
  });
  const before = database.sqlite.prepare("SELECT * FROM endfield_bindings").get();
  const fingerprint = vi
    .fn<typeof fetch>(() => {
      throw new Error("Unconfigured external request");
    })
    .mockResolvedValueOnce(
      Response.json({ code: 1902, message: "Fingerprint service unavailable" }),
    );
  vi.stubGlobal("fetch", fingerprint);
  const first = await getBindingWithDeviceProfile(database.db, "user");
  expect(first?.binding).toEqual(before);
  expect(first?.deviceProfile.deviceId).toBeTruthy();
  const saved = database.sqlite
    .prepare("SELECT device_profile FROM endfield_role_device_profiles WHERE role_id = 'role'")
    .get()!;
  expect(JSON.parse(String(saved.device_profile))).toEqual(first?.deviceProfile);
  expect(await getBindingWithDeviceProfile(database.db, "user")).toEqual(first);
  expect(fingerprint).toHaveBeenCalledOnce();
  expect(database.sqlite.prepare("SELECT * FROM endfield_bindings").get()).toEqual(before);
});

it("moves a historical binding's valid device identity into role storage without registering another device", async () => {
  await saveBinding(database.db, "user", "skland", role, {
    cred: "stored-credential",
    token: "stored-token",
  });
  const legacyProfile = createEndfieldDeviceProfile(
    "historical-device-1234567890",
    SKLAND_DEVICE_PROFILE_USER_AGENT,
  );
  database.sqlite
    .prepare("UPDATE endfield_bindings SET device_profile = ? WHERE uid = 'user'")
    .run(serializeEndfieldDeviceProfile(legacyProfile));
  const before = database.sqlite.prepare("SELECT * FROM endfield_bindings").get();
  const fingerprint = vi.fn<typeof fetch>(() => {
    throw new Error("Unconfigured fingerprint request");
  });
  vi.stubGlobal("fetch", fingerprint);
  const result = await getBindingWithDeviceProfile(database.db, "user");
  expect(result).toEqual({ binding: before, deviceProfile: legacyProfile });
  const saved = database.sqlite
    .prepare("SELECT device_profile FROM endfield_role_device_profiles WHERE role_id = 'role'")
    .get()!;
  expect(JSON.parse(String(saved.device_profile))).toEqual(legacyProfile);
  expect(database.sqlite.prepare("SELECT * FROM endfield_bindings").get()).toEqual(before);
  expect(fingerprint).not.toHaveBeenCalled();
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
