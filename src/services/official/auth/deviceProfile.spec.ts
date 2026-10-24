import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { saveBinding } from "@/repositories/binding/repository";
import {
  createEndfieldDeviceProfile,
  SKLAND_DEVICE_PROFILE_USER_AGENT,
} from "@/services/official/client/deviceProfile";
import { serializeEndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertUser } from "@/test/fixtures/users";

import { getBindingWithDeviceProfile } from "./deviceProfile";

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
  const originalBinding = database.sqlite.prepare("SELECT * FROM endfield_bindings").get();
  const fingerprint = vi
    .fn<typeof fetch>(() => {
      throw new Error("Unconfigured external request");
    })
    .mockResolvedValueOnce(
      Response.json({ code: 1902, message: "Fingerprint service unavailable" }),
    );
  vi.stubGlobal("fetch", fingerprint);
  const recoveredBinding = await getBindingWithDeviceProfile(database.db, "user");
  expect(recoveredBinding?.binding).toEqual(originalBinding);
  expect(recoveredBinding?.deviceProfile.deviceId).toBeTruthy();
  const saved = database.sqlite
    .prepare("SELECT device_profile FROM endfield_role_device_profiles WHERE role_id = 'role'")
    .get()!;
  expect(JSON.parse(String(saved.device_profile))).toEqual(recoveredBinding?.deviceProfile);
  expect(await getBindingWithDeviceProfile(database.db, "user")).toEqual(recoveredBinding);
  // Reusing the persisted fallback avoids registering a new device on every read.
  expect(fingerprint).toHaveBeenCalledOnce();
  expect(database.sqlite.prepare("SELECT * FROM endfield_bindings").get()).toEqual(originalBinding);
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
  const originalBinding = database.sqlite.prepare("SELECT * FROM endfield_bindings").get();
  const fingerprint = vi.fn<typeof fetch>(() => {
    throw new Error("Unconfigured fingerprint request");
  });
  vi.stubGlobal("fetch", fingerprint);
  const result = await getBindingWithDeviceProfile(database.db, "user");
  expect(result).toEqual({ binding: originalBinding, deviceProfile: legacyProfile });
  const saved = database.sqlite
    .prepare("SELECT device_profile FROM endfield_role_device_profiles WHERE role_id = 'role'")
    .get()!;
  expect(JSON.parse(String(saved.device_profile))).toEqual(legacyProfile);
  expect(database.sqlite.prepare("SELECT * FROM endfield_bindings").get()).toEqual(originalBinding);
  expect(fingerprint).not.toHaveBeenCalled();
});
