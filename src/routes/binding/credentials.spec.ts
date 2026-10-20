import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/errors";
import { SqliteD1 } from "../../test/sqliteD1";
import type { Bindings } from "../../types/app";
import { getDecryptedBinding, refreshBindingCredentials } from "./credentials";
import { deleteLocatorCaches, readDecryptedBindingCache } from "./locatorCache";
import type { AppContext, EndfieldBindingRow } from "./types";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../lib/crypto", () => ({
  encryptSecret: async (value: string) => `sealed:${value}`,
  decryptSecret: async (value: string) => value.replace("sealed:", ""),
}));
vi.mock("../../lib/endfieldClient/authClient", () => ({
  refreshEndfieldAuth: mocks.refresh,
  grantEndfieldOAuthCode: vi.fn(),
  generateEndfieldCredByCode: vi.fn(),
}));
vi.mock("../../lib/endfieldClient/deviceProfile", () => ({
  createEndfieldDeviceId: async () => "new-device",
  createEndfieldDeviceProfile: () => ({ deviceId: "new-device" }),
  serializeEndfieldDeviceProfile: JSON.stringify,
  SKLAND_DEVICE_PROFILE_USER_AGENT: "agent",
}));
vi.mock("./repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository")>()),
  getBindingWithDeviceProfile: async (db: D1Database, uid: string) => {
    const row = await db
      .prepare("SELECT * FROM endfield_bindings WHERE uid = ?1")
      .bind(uid)
      .first<EndfieldBindingRow>();
    return row ? { binding: row, deviceProfile: { deviceId: "old-device" } } : null;
  },
  publicBinding: (binding: EndfieldBindingRow) => ({ roleId: binding.role_id }),
}));

describe("request-owned credential refresh and conditional persistence", () => {
  let database: SqliteD1;
  let env: Bindings;
  const context = () => ({ env }) as AppContext;
  beforeEach(() => {
    vi.clearAllMocks();
    database = new SqliteD1();
    database.sqlite.exec(`CREATE TABLE endfield_bindings (
      uid TEXT PRIMARY KEY, provider TEXT, server_id INTEGER, role_id TEXT,
      cred_enc TEXT, token_enc TEXT, account_token_enc TEXT, status TEXT, updated_at TEXT
    ); CREATE TABLE endfield_role_device_profiles (role_id TEXT PRIMARY KEY, device_profile TEXT, updated_at TEXT);
    INSERT INTO endfield_bindings VALUES ('user', 'skland', 1, 'role', 'sealed:cred', 'sealed:token', NULL, 'enabled', 'old');`);
    env = {
      DB: database.db,
      ENDFIELD_CREDENTIAL_SECRET: "test-secret-at-least-16-characters",
    } as Bindings;
    mocks.refresh.mockResolvedValue({ token: "new-token" });
  });
  afterEach(() => database.sqlite.close());

  it("deduplicates refreshes inside the same request", async () => {
    const c = context();
    const binding = await getDecryptedBinding(c, "user");
    const result = await Promise.all([
      refreshBindingCredentials(c, "user", binding),
      refreshBindingCredentials(c, "user", binding),
    ]);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(result[0]).toBe(result[1]);
    expect(result[0]!.token).toBe("new-token");
  });

  it("does not block another request or let a late refresh overwrite its committed credentials", async () => {
    const binding = await getDecryptedBinding(context(), "user");
    let release!: (value: { token: string }) => void;
    mocks.refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = refreshBindingCredentials(context(), "user", binding);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    const second = await refreshBindingCredentials(context(), "user", binding);
    expect(second.token).toBe("new-token");
    release({ token: "late-token" });
    expect((await first).token).toBe("new-token");
    expect(
      database.sqlite.prepare("SELECT token_enc FROM endfield_bindings").get()!.token_enc,
    ).toBe("sealed:new-token");
  });

  it("cannot resurrect a binding unlinked during a refresh", async () => {
    const binding = await getDecryptedBinding(context(), "user");
    let release!: (value: { token: string }) => void;
    mocks.refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = refreshBindingCredentials(context(), "user", binding);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    database.sqlite.exec("DELETE FROM endfield_bindings");
    deleteLocatorCaches(env, "user");
    release({ token: "late-token" });
    await expect(pending).rejects.toMatchObject({ code: "ENDFIELD_BINDING_NOT_FOUND" });
    expect(readDecryptedBindingCache(env, "user")).toBeNull();
  });

  it("commits a recovered device profile atomically with its matching credentials", async () => {
    const binding = await getDecryptedBinding(context(), "user");
    mocks.refresh.mockRejectedValueOnce(
      new ApiError(502, "ENDFIELD_DEVICE_REJECTED", "device rejected"),
    );
    await expect(refreshBindingCredentials(context(), "user", binding)).resolves.toMatchObject({
      token: "new-token",
      deviceProfile: { deviceId: "new-device" },
    });
    expect(
      database.sqlite.prepare("SELECT device_profile FROM endfield_role_device_profiles").get()!
        .device_profile,
    ).toBe('{"deviceId":"new-device"}');
    expect(
      database.sqlite.prepare("SELECT token_enc FROM endfield_bindings").get()!.token_enc,
    ).toBe("sealed:new-token");
  });

  it("skips a late device-profile write when another request has already refreshed credentials", async () => {
    const binding = await getDecryptedBinding(context(), "user");
    let release!: (value: { token: string }) => void;
    mocks.refresh
      .mockRejectedValueOnce(new ApiError(502, "ENDFIELD_DEVICE_REJECTED", "device rejected"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    const first = refreshBindingCredentials(context(), "user", binding);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    await refreshBindingCredentials(context(), "user", binding);
    release({ token: "late-token" });
    expect((await first).token).toBe("new-token");
    expect(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM endfield_role_device_profiles").get()!
        .count,
    ).toBe(0);
    expect(
      database.sqlite.prepare("SELECT token_enc FROM endfield_bindings").get()!.token_enc,
    ).toBe("sealed:new-token");
  });

  it("rolls back the credential update when device-profile persistence fails", async () => {
    const binding = await getDecryptedBinding(context(), "user");
    database.sqlite.exec(
      "CREATE TRIGGER reject_profile BEFORE INSERT ON endfield_role_device_profiles BEGIN SELECT RAISE(ABORT, 'profile write rejected'); END",
    );
    mocks.refresh.mockRejectedValueOnce(
      new ApiError(502, "ENDFIELD_DEVICE_REJECTED", "device rejected"),
    );
    await expect(refreshBindingCredentials(context(), "user", binding)).rejects.toThrow(
      "profile write rejected",
    );
    expect(
      database.sqlite.prepare("SELECT token_enc FROM endfield_bindings").get()!.token_enc,
    ).toBe("sealed:token");
  });
});
