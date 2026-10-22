import { afterEach, beforeEach, expect, it } from "vitest";

import { decryptSecret } from "@/lib/crypto";
import { createEndfieldDeviceProfile } from "@/lib/endfieldClient/deviceProfile";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertUser } from "@/test/fixtures/users";

import { bindRole, disableBinding, unlinkBinding, type BindingDependencies } from "./binding";
import { savePendingSession } from "./pendingSession";

const secret = "test-secret-at-least-16-characters";
const role = {
  serverId: 1,
  roleId: "role",
  nickname: "Player",
  level: 10,
  serverType: "test",
  serverName: "Server",
  isDefault: true,
};
let database: TestDatabase;
let dependencies: BindingDependencies;
let records: Map<string, unknown>;

beforeEach(() => {
  database = createTestDatabase();
  insertUser(database.sqlite, { uid: "user" });
  records = new Map();
  dependencies = {
    db: database.db,
    pending: {
      redis: () => ({
        get: async <T>(key: string) => (records.get(key) ?? null) as T | null,
        set: async (key: string, value: unknown) => {
          records.set(key, value);
          return "OK";
        },
        del: async (key: string) => Number(records.delete(key)),
      }),
      key: async (uid, flowId) => `${uid}:${flowId}`,
    },
    credentialSecret: () => secret,
    invalidateCaches: () => {},
  };
});
afterEach(() => database.close());

async function startFlow() {
  return savePendingSession(dependencies.pending, "user", {
    provider: "skland",
    cred: "external-cred",
    token: "external-token",
    accountToken: "account-token",
    roles: [role],
    createdAt: Date.now(),
    deviceProfile: createEndfieldDeviceProfile("a".repeat(32)),
  });
}

it("binds a role from the user's flow and consumes it", async () => {
  const flowId = await startFlow();
  const binding = await bindRole(
    { uid: "user", flowId, serverId: 1, roleId: "role" },
    dependencies,
  );
  expect(binding).toMatchObject({ uid: "user", role_id: "role", status: "enabled" });
  expect(await decryptSecret(binding!.cred_enc, secret)).toBe("external-cred");
  expect(await decryptSecret(binding!.account_token_enc!, secret)).toBe("account-token");
  await expect(
    bindRole({ uid: "user", flowId, serverId: 1, roleId: "role" }, dependencies),
  ).rejects.toMatchObject({ status: 410, code: "ENDFIELD_BINDING_FLOW_EXPIRED" });
});

it("rejects another user's flow and an unlisted role without consuming the owner's flow", async () => {
  const flowId = await startFlow();
  await expect(
    bindRole({ uid: "other", flowId, serverId: 1, roleId: "role" }, dependencies),
  ).rejects.toMatchObject({ status: 410, code: "ENDFIELD_BINDING_FLOW_EXPIRED" });
  await expect(
    bindRole({ uid: "user", flowId, serverId: 2, roleId: "role" }, dependencies),
  ).rejects.toMatchObject({ status: 404, code: "ENDFIELD_ROLE_NOT_FOUND" });
  expect(
    await bindRole({ uid: "user", flowId, serverId: 1, roleId: "role" }, dependencies),
  ).toMatchObject({ role_id: "role", server_id: 1 });
});

it("retains a pending flow after a binding write fails so it can be retried", async () => {
  const flowId = await startFlow();
  database.sqlite.exec(
    "CREATE TRIGGER reject_binding BEFORE INSERT ON endfield_bindings BEGIN SELECT RAISE(ABORT, 'binding write rejected'); END",
  );
  await expect(
    bindRole({ uid: "user", flowId, serverId: 1, roleId: "role" }, dependencies),
  ).rejects.toThrow("binding write rejected");
  database.sqlite.exec("DROP TRIGGER reject_binding");
  expect(
    await bindRole({ uid: "user", flowId, serverId: 1, roleId: "role" }, dependencies),
  ).toMatchObject({ status: "enabled" });
});

it("can disable and then unlink a binding without affecting another user", async () => {
  const flowId = await startFlow();
  await bindRole({ uid: "user", flowId, serverId: 1, roleId: "role" }, dependencies);
  expect(await disableBinding({ uid: "user" }, dependencies)).toMatchObject({
    status: "disabled",
    role_id: "role",
  });
  await unlinkBinding({ uid: "other" }, dependencies);
  expect(await disableBinding({ uid: "user" }, dependencies)).toMatchObject({ status: "disabled" });
  await unlinkBinding({ uid: "user" }, dependencies);
  expect(await disableBinding({ uid: "user" }, dependencies)).toBeNull();
});
