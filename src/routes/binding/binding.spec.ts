import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/errors";
import { SqliteD1 } from "@/test/sqliteD1";
import type { AppEnv, AuthUser, Bindings } from "@/types/app";

const redis = vi.hoisted(() => ({
  records: new Map<string, { value: unknown; expiresAt: number }>(),
}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
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
// Authentication and rate limiting have their own tests. These requests supply a known identity.
vi.mock("@/middleware/auth", () => ({
  requireAuth: async (c: { get(key: string): unknown }, next: () => Promise<void>) => {
    if (!c.get("authUser")) {
      throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
    }
    await next();
  },
}));
vi.mock("@/middleware/rate-limit", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { createRoutes } from "./createRoutes";

let database: SqliteD1;
let env: Bindings;
const external = vi.fn<typeof fetch>();
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
  database = new SqliteD1();
  database.sqlite.exec(`CREATE TABLE endfield_bindings (
    uid TEXT PRIMARY KEY, provider TEXT, server_id INTEGER, role_id TEXT, role_nickname TEXT,
    server_name TEXT, cred_enc TEXT, token_enc TEXT, account_token_enc TEXT, status TEXT, updated_at TEXT
  ); CREATE TABLE endfield_role_device_profiles (
    role_id TEXT PRIMARY KEY, device_profile TEXT, updated_at TEXT
  );`);
  env = { DB: database.db, BETTER_AUTH_SECRET: "test-secret-at-least-16-characters" } as Bindings;
  redis.records.clear();
  external.mockReset();
  vi.stubGlobal("fetch", external);
});
afterEach(() => {
  database.sqlite.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(path: string, payload?: unknown, uid: string | null = "user") {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return new Response(
        JSON.stringify({ code: error.code, message: error.message, details: error.details }),
        {
          status: error.status,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return c.json({ message: error.message }, 500);
  });
  if (uid) {
    app.use("*", async (c, next) => {
      c.set("authUser", { uid } as AuthUser);
      c.set("requestId", "binding-request");
      await next();
    });
  }
  app.route("/binding/v1", createRoutes());
  return app.request(
    `http://localhost/binding/v1/endfield/${path}`,
    payload === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "test-browser" },
          body: typeof payload === "string" ? payload : JSON.stringify(payload),
        },
    env,
  );
}

function upstreamRoles(roles = [role]) {
  external
    .mockResolvedValueOnce(Response.json({ code: 0, data: { cred: "cred", token: "token" } }))
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
      external.mockResolvedValueOnce(Response.json({ status: 0, data: { code: "oauth-code" } }));
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
    expect(external.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
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
    expect(await bound.json()).toEqual({ ok: true, binding: summary });
    expect(await (await request("status")).json()).toEqual({ binding: summary });
    expect(await (await request("status", undefined, "other")).json()).toEqual({
      binding: { bound: false, enabled: false },
    });
    expect(await (await request("disable", {})).json()).toEqual({
      ok: true,
      binding: { ...summary, enabled: false },
    });
    expect(await (await request("unlink", {})).json()).toEqual({
      ok: true,
      binding: { bound: false, enabled: false },
    });
    expect(external).toHaveBeenCalledTimes(kind === "token" ? 3 : 2);
  },
);

it("keeps token validation details and the existing malformed-JSON distinction", async () => {
  const payload = { provider: "skland", token: "short" };
  const response = await request("exchange-token", payload);
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
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
  expect(external).not.toHaveBeenCalled();
});

it("requires a site identity before exchanging external credentials", async () => {
  expect(
    (await request("exchange-token", { provider: "skland", token: "external-value" }, null)).status,
  ).toBe(401);
  expect(external).not.toHaveBeenCalled();
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
  expect(await bound.json()).toEqual({
    code: "ENDFIELD_BINDING_FLOW_EXPIRED",
    message: "Binding flow expired. Please exchange the token again.",
  });
});

it("preserves upstream errors and the token-exchange request log", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  external.mockResolvedValueOnce(Response.json({ status: 1, msg: "rejected" }));
  const response = await request("exchange-token", {
    provider: "skland",
    token: "external-value",
    deviceId,
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
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
  upstreamRoles([]);
  const response = await request("exchange-code", {
    provider: "skland",
    code: "oauth-code",
    deviceId,
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    code: "ENDFIELD_ROLE_NOT_FOUND",
    message: "No Endfield roles found on this account.",
  });
  expect(redis.records.size).toBe(0);
});
