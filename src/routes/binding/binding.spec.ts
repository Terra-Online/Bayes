import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { decryptSecret } from "@/lib/crypto";
import type { EndfieldProvider, EndfieldRoleOption } from "@/lib/endfieldClient/types";
import { onAppError } from "@/middleware/error-handler";
import type { PendingSessionRedis } from "@/repositories/binding/pendingSession";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type AuthenticatedUserFixture } from "@/test/fixtures/auth";
import type { AppEnv, Bindings } from "@/types/app";

const redis = vi.hoisted(() => ({
  records: new Map<string, { value: unknown; expiresAt: number }>(),
}));
vi.mock("@upstash/redis", () => ({
  Redis: class implements PendingSessionRedis {
    async set(key: string, value: string, options: { ex: number }) {
      redis.records.set(key, {
        value: JSON.parse(value),
        expiresAt: Date.now() + options.ex * 1000,
      });
      return "OK";
    }
    async get(key: string) {
      const record = redis.records.get(key);
      return record && record.expiresAt > Date.now() ? record.value : null;
    }
    async del(key: string) {
      return Number(redis.records.delete(key));
    }
  },
}));
import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let env: Bindings;
let sessions: Map<string, AuthenticatedUserFixture>;
let endfieldFetch: ReturnType<typeof vi.fn<typeof fetch>>;
const role = {
  serverId: 1,
  roleId: "role",
  nickname: "Player",
  level: 10,
  serverType: "test",
  serverName: "Server",
  isDefault: true,
};
const deviceId = "a".repeat(32);

beforeEach(() => {
  database = createTestDatabase();
  sessions = new Map(
    ["user", "other"].map((uid) => [uid, insertAuthenticatedUser(database.sqlite, { uid })]),
  );
  const mocks = createMockBindings({ DB: database.db });
  mocks.bindingRateLimit.limit.mockResolvedValue({ success: true });
  env = mocks.bindings;
  redis.records = new Map();
  endfieldFetch = vi.fn<typeof fetch>(() => {
    throw new Error("Unconfigured Endfield fetch");
  });
  vi.stubGlobal("fetch", endfieldFetch);
});
afterEach(() => {
  database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(path: string, payload?: unknown, uid: string | null = "user") {
  const app = new Hono<AppEnv<{ requestId: string }>>();
  app.onError(onAppError);
  app.use("*", async (c, next) => {
    c.set("requestId", "binding-request");
    await next();
  });
  app.route("/binding/v1", createRoutes());
  const headers = {
    ...(uid ? sessions.get(uid)!.headers : {}),
    "content-type": "application/json",
    "user-agent": "test-browser",
  };
  return runWithAuthRequest(() =>
    app.request(
      `http://localhost/binding/v1/endfield/${path}`,
      payload === undefined
        ? { headers }
        : {
            method: "POST",
            headers,
            body: typeof payload === "string" ? payload : JSON.stringify(payload),
          },
      env,
    ),
  );
}

interface UpstreamRolesFixture {
  roles?: EndfieldRoleOption[];
  cred?: string;
  token?: string;
}

function upstreamRoles({
  roles = [role],
  cred = "cred",
  token = "token",
}: UpstreamRolesFixture = {}): void {
  endfieldFetch
    .mockResolvedValueOnce(Response.json({ code: 0, data: { cred, token } }))
    .mockResolvedValueOnce(
      Response.json({
        code: 0,
        data: { list: [{ appCode: "endfield", bindingList: [{ roles }] }] },
      }),
    );
}

it.each(["token", "code"] as const)(
  "exchanges a %s, binds the selected role, and returns only a public summary",
  async (kind) => {
    if (kind === "token") {
      endfieldFetch.mockResolvedValueOnce(
        Response.json({ status: 0, data: { code: "oauth-code" } }),
      );
    }
    upstreamRoles();
    const response = await request(`exchange-${kind}`, {
      provider: "skport",
      [kind]: "external-value",
      deviceId,
    });
    expect(response.status).toBe(200);
    const flow = (await response.json()) as { flowId: string; roles: unknown[] };
    expect(flow.roles).toEqual([role]);
    expect(endfieldFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      ...(kind === "token" ? ["/user/oauth2/v2/grant"] : []),
      "/web/v1/user/auth/generate_cred_by_code",
      "/api/v1/game/player/binding",
    ]);
    const bound = await request("bind-role", { flowId: flow.flowId, serverId: 1, roleId: "role" });
    expect(bound.status).toBe(200);
    const summary = {
      bound: true,
      enabled: true,
      provider: "skport",
      serverId: 1,
      roleId: "role",
      nickname: "Player",
      serverName: "Server",
      updatedAt: expect.any(String),
    };
    const stored = database.sqlite
      .prepare("SELECT * FROM endfield_bindings WHERE uid = ?")
      .get("user")!;
    expect(stored).toMatchObject({
      uid: "user",
      provider: "skport",
      role_id: "role",
      server_id: 1,
      status: "enabled",
    });
    expect(await decryptSecret(String(stored.cred_enc), env.BETTER_AUTH_SECRET!)).toBe("cred");
    if (kind === "token") {
      expect(await decryptSecret(String(stored.account_token_enc), env.BETTER_AUTH_SECRET!)).toBe(
        "external-value",
      );
    }
    const consumed = await request("bind-role", {
      flowId: flow.flowId,
      serverId: 1,
      roleId: "role",
    });
    expect(consumed.status).toBe(410);
    expect(await consumed.json()).toMatchObject({ code: "ENDFIELD_BINDING_FLOW_EXPIRED" });
    expect(await bound.json()).toEqual({ ok: true, binding: summary });
    expect(await (await request("status")).json()).toEqual({ binding: summary });
    expect(await (await request("status", undefined, "other")).json()).toEqual({
      binding: { bound: false, enabled: false },
    });
    expect(await (await request("disable", {})).json()).toEqual({
      ok: true,
      binding: { ...summary, enabled: false },
    });
    expect((await request("unlink", {}, "other")).status).toBe(200);
    expect(await (await request("disable", {})).json()).toEqual({
      ok: true,
      binding: { ...summary, enabled: false },
    });
    expect(
      database.sqlite
        .prepare("SELECT status, role_id FROM endfield_bindings WHERE uid = ?")
        .get("user"),
    ).toMatchObject({ status: "disabled", role_id: "role" });
    expect(await (await request("unlink", {})).json()).toEqual({
      ok: true,
      binding: { bound: false, enabled: false },
    });
    expect(await (await request("disable", {})).json()).toEqual({
      ok: true,
      binding: { bound: false, enabled: false },
    });
    expect(
      database.sqlite.prepare("SELECT * FROM endfield_bindings WHERE uid = ?").get("user"),
    ).toBeUndefined();
    expect(endfieldFetch).toHaveBeenCalledTimes(kind === "token" ? 3 : 2);
  },
);

it("keeps token validation details and the existing malformed-JSON distinction", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const payload = { provider: "skland", token: "short" };
  const response = await request("exchange-token", payload);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    code: "VALIDATION_ERROR",
    message: "Invalid exchange payload.",
    details: {
      formErrors: [],
      fieldErrors: { token: ["Too small: expected string to have >=8 characters"] },
    },
  });
  expect((await request("exchange-token", "{")).status).toBe(422);
  expect((await request("exchange-code", "{")).status).toBe(500);
  expect((await request("bind-role", "{")).status).toBe(500);
  expect(endfieldFetch).not.toHaveBeenCalled();
});

it("requires a site identity before exchanging external credentials", async () => {
  expect(
    (await request("exchange-token", { provider: "skland", token: "external-value" }, null)).status,
  ).toBe(401);
  expect(endfieldFetch).not.toHaveBeenCalled();
});

it("expires an unconfirmed binding flow after ten minutes", async () => {
  upstreamRoles();
  const response = await request("exchange-code", {
    provider: "skland",
    code: "oauth-code",
    deviceId,
  });
  const { flowId } = (await response.json()) as { flowId: string };
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
  const bound = await request("bind-role", { flowId, serverId: 1, roleId: "role" });
  expect(bound.status).toBe(410);
  expect(await bound.json()).toMatchObject({
    code: "ENDFIELD_BINDING_FLOW_EXPIRED",
    message: "Binding flow expired. Please exchange the token again.",
  });
});

it("preserves upstream errors and the token-exchange request log", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  endfieldFetch.mockResolvedValueOnce(Response.json({ status: 1, msg: "rejected" }));
  const response = await request("exchange-token", {
    provider: "skland",
    token: "external-value",
    deviceId,
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    code: "ENDFIELD_AUTH_REJECTED",
    message: "rejected",
    details: { upstreamStatus: 200, upstreamCode: 1, upstreamMessage: "rejected" },
  });
  expect(warn).toHaveBeenCalledWith(
    "[binding][endfield][exchange-token] failed",
    expect.objectContaining({
      requestId: "binding-request",
      provider: "skland",
      code: "ENDFIELD_AUTH_REJECTED",
    }),
  );
});

it("does not start a flow when the external account has no Endfield roles", async () => {
  upstreamRoles({ roles: [] });
  const response = await request("exchange-code", {
    provider: "skland",
    code: "oauth-code",
    deviceId,
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    code: "ENDFIELD_ROLE_NOT_FOUND",
    message: "No Endfield roles found on this account.",
  });
  expect(redis.records.size).toBe(0);
});

interface TokenFlowFixture {
  provider?: EndfieldProvider;
  accountToken?: string;
  cred?: string;
  token?: string;
}

async function startTokenFlow({
  provider = "skland",
  accountToken = "account-token",
  cred = "external-cred",
  token = "external-token",
}: TokenFlowFixture = {}): Promise<string> {
  endfieldFetch.mockResolvedValueOnce(Response.json({ status: 0, data: { code: "oauth-code" } }));
  upstreamRoles({ cred, token });
  const response = await request("exchange-token", { provider, token: accountToken, deviceId });
  expect(response.status).toBe(200);
  const flow = (await response.json()) as { flowId: string };
  return flow.flowId;
}

it("rejects another user's flow and an unlisted role without consuming the owner's flow", async () => {
  const flowId = await startTokenFlow();
  const other = await request("bind-role", { flowId, serverId: 1, roleId: "role" }, "other");
  expect(other.status).toBe(410);
  expect(await other.json()).toMatchObject({ code: "ENDFIELD_BINDING_FLOW_EXPIRED" });
  const unlisted = await request("bind-role", { flowId, serverId: 2, roleId: "role" });
  expect(unlisted.status).toBe(404);
  expect(await unlisted.json()).toMatchObject({ code: "ENDFIELD_ROLE_NOT_FOUND" });
  const bound = await request("bind-role", { flowId, serverId: 1, roleId: "role" });
  expect(bound.status).toBe(200);
  expect(await bound.json()).toMatchObject({ binding: { roleId: "role", serverId: 1 } });
  expect(
    database.sqlite
      .prepare("SELECT role_id, server_id FROM endfield_bindings WHERE uid = ?")
      .get("user"),
  ).toMatchObject({ role_id: "role", server_id: 1 });
});

it("retains a pending flow after a binding write fails so it can be retried", async () => {
  const flowId = await startTokenFlow();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  database.sqlite.exec(
    "CREATE TRIGGER reject_binding BEFORE INSERT ON endfield_bindings BEGIN SELECT RAISE(ABORT, 'binding write rejected'); END",
  );
  const failed = await request("bind-role", { flowId, serverId: 1, roleId: "role" });
  expect(failed.status).toBe(500);
  expect(errorLog).toHaveBeenCalledWith(
    "request failed",
    expect.objectContaining({
      rawError: expect.objectContaining({
        message: expect.stringContaining("binding write rejected"),
      }),
    }),
  );
  // The profile write precedes the binding write; this only promises a retryable flow.
  database.sqlite.exec("DROP TRIGGER reject_binding");
  const retried = await request("bind-role", { flowId, serverId: 1, roleId: "role" });
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ binding: { enabled: true } });
  expect(
    database.sqlite.prepare("SELECT status FROM endfield_bindings WHERE uid = ?").get("user"),
  ).toMatchObject({ status: "enabled" });
});

it("preserves the account token when creating and replacing a binding", async () => {
  for (const credentials of [
    { provider: "skland", cred: "cred", token: "token", accountToken: "account-token" },
    { provider: "skport", cred: "new-cred", token: "new-token", accountToken: "new-account-token" },
  ] as const) {
    const flowId = await startTokenFlow(credentials);
    expect((await request("bind-role", { flowId, serverId: 1, roleId: "role" })).status).toBe(200);
    const stored = database.sqlite
      .prepare("SELECT * FROM endfield_bindings WHERE uid = ?")
      .get("user")!;
    expect(stored.provider).toBe(credentials.provider);
    expect(await decryptSecret(String(stored.cred_enc), env.BETTER_AUTH_SECRET!)).toBe(
      credentials.cred,
    );
    expect(await decryptSecret(String(stored.token_enc), env.BETTER_AUTH_SECRET!)).toBe(
      credentials.token,
    );
    expect(await decryptSecret(String(stored.account_token_enc), env.BETTER_AUTH_SECRET!)).toBe(
      credentials.accountToken,
    );
  }
});
