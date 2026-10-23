import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptSecret } from "@/lib/crypto";
import type { EndfieldRoleOption } from "@/lib/endfieldClient/types";
import { onAppError } from "@/middleware/error-handler";
import { createRoutes as locatorRoutes } from "@/routes/locator/createRoutes";
import { createRoutes as positionRoutes } from "@/routes/locator/positionRoutes";
import { createRoutes as syncRoutes } from "@/routes/sync/createRoutes";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes as bindingRoutes } from "./createRoutes";

const boundary = vi.hoisted(() => ({
  pending: new Map<string, { value: unknown; expiresAt: number }>(),
}));
// Substitute lookup data while keeping the official-marks application service real.
vi.mock("@/routes/binding/officialMarkerHashToPointId.json", () => ({
  default: { "mark-a": "point-a", "mark-b": "point-b" },
}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async set(key: string, value: string, options: { ex: number }) {
      boundary.pending.set(key, {
        value: JSON.parse(value),
        expiresAt: Date.now() + options.ex * 1000,
      });
      return "OK";
    }
    async get(key: string) {
      const record = boundary.pending.get(key);
      return record && record.expiresAt > Date.now() ? record.value : null;
    }
    async del(key: string) {
      return Number(boundary.pending.delete(key));
    }
  },
}));

const talosRole: EndfieldRoleOption = {
  serverId: 1,
  roleId: "talos-role",
  nickname: "Talos Explorer",
  level: 20,
  serverType: "official",
  serverName: "Talos",
  isDefault: true,
};
const wulingRole: EndfieldRoleOption = {
  ...talosRole,
  serverId: 2,
  roleId: "wuling-role",
  nickname: "Wuling Explorer",
  serverName: "Wuling",
  isDefault: false,
};
const deviceId = "binding-browser-device-12345678";
const position = {
  pos: { x: 125, y: 4, z: -80 },
  isOnline: true,
  mapId: "map01",
  levelId: "talos-outpost",
};
const external = vi.fn<typeof fetch>();
const positionFetch = vi.fn<(request: Request) => Promise<Response>>();
let database: TestDatabase;
let env: Bindings;
let app: Hono<AppEnv<{ requestId: string }>>;
let sessions: Map<string, ReturnType<typeof insertSession>>;

beforeEach(() => {
  database = createTestDatabase();
  sessions = new Map();
  for (const uid of ["owner", "neighbor"]) {
    insertUser(database.sqlite, { uid });
    insertAuthUser(database.sqlite, { id: uid });
    sessions.set(uid, insertSession(database.sqlite, { userId: uid }));
  }
  env = {
    DB: database.db,
    ...testAuthConfig,
    OEM_BINDING_RATE_LIMIT: { limit: async () => ({ success: true }) },
  } as unknown as Bindings;
  app = new Hono<AppEnv<{ requestId: string }>>()
    .use("*", async (c, next) => {
      c.set("requestId", "endfield-lifecycle");
      await next();
    })
    .onError(onAppError)
    .route("/binding/v1", bindingRoutes())
    .route("/sync/v1", syncRoutes())
    .route("/locator", positionRoutes())
    .route("/locator", locatorRoutes());
  boundary.pending.clear();
  positionFetch
    .mockReset()
    .mockImplementation(async () => Response.json({ code: 0, data: position }));
  external.mockReset().mockImplementation(async (url) => {
    throw new Error(`Unexpected external request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return new URL(request.url).pathname === "/web/v1/game/endfield/map/me/position"
      ? positionFetch(request)
      : external(input, init);
  });
});

afterEach(() => {
  database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(
  path: string,
  payload?: unknown,
  uid = "owner",
  headers: Record<string, string> = {},
) {
  return app.request(
    `http://localhost${path}`,
    {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        ...sessions.get(uid)?.headers,
        "content-type": "application/json",
        "user-agent": "endfield-test-browser",
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    },
    env,
  );
}

async function startFlow(
  uid = "owner",
  roles = [talosRole, wulingRole],
  kind: "code" | "token" = "code",
) {
  if (kind === "token") {
    external.mockResolvedValueOnce(Response.json({ status: 0, data: { code: "granted-code" } }));
  }
  external
    .mockResolvedValueOnce(
      Response.json({
        code: 0,
        data: { cred: "player-credential", token: "player-signing-token" },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        code: 0,
        data: { list: [{ appCode: "endfield", bindingList: [{ roles }] }] },
      }),
    );
  const response = await request(
    `/binding/v1/endfield/exchange-${kind}`,
    { provider: "skland", [kind]: "external-account-token", deviceId },
    uid,
  );
  expect(response.status).toBe(200);
  const flow = (await response.json()) as { flowId: string; roles: EndfieldRoleOption[] };
  expect(flow.roles).toEqual(roles);
  return flow.flowId;
}

function selectRole(flowId: string, role = talosRole, uid = "owner") {
  return request(
    "/binding/v1/endfield/bind-role",
    { flowId, serverId: role.serverId, roleId: role.roleId },
    uid,
  );
}

async function bind(uid = "owner", role = talosRole, kind: "code" | "token" = "code") {
  const flowId = await startFlow(uid, [role], kind);
  expect((await selectRole(flowId, role, uid)).status).toBe(200);
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ code });
}

function storedBinding(uid = "owner") {
  return database.sqlite.prepare("SELECT * FROM endfield_bindings WHERE uid = ?").get(uid);
}

function upstreamMaps(map01: unknown = [], map02: unknown = []) {
  external.mockImplementation(async (url) => {
    const target = new URL(String(url));
    expect(target.pathname).toBe("/web/v1/game/endfield/map/mark/list");
    return Response.json({
      code: 0,
      data: target.searchParams.get("mapId") === "map01" ? map01 : map02,
    });
  });
}

// Both signed map requests must reach the external boundary before returning a rejection.
// Otherwise Promise.all can reject while its sibling is still signing, leaking into the next test.
function bothMapRequests() {
  const maps = new Set<string | null>();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (target: URL) => {
    maps.add(target.searchParams.get("mapId"));
    if (maps.size === 2) {
      release();
    }
    await ready;
  };
}

describe("official marks through HTTP", () => {
  it("uses the saved account token when ordinary credential refresh cannot recover sync", async () => {
    await bind("owner", talosRole, "token");
    const mapsReady = bothMapRequests();
    external.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      switch (target.pathname) {
        case "/web/v1/auth/refresh":
          return Response.json({ code: 401, message: "Refresh rejected" });
        case "/user/oauth2/v2/grant":
          expect(JSON.parse(String(init?.body))).toMatchObject({ token: "external-account-token" });
          return Response.json({ status: 0, data: { code: "replacement-code" } });
        case "/web/v1/user/auth/generate_cred_by_code":
          expect(JSON.parse(String(init?.body))).toMatchObject({ code: "replacement-code" });
          return Response.json({
            code: 0,
            data: { cred: "replacement-credential", token: "replacement-signing-token" },
          });
        default:
          expect(target.pathname).toBe("/web/v1/game/endfield/map/mark/list");
          if (new Headers(init?.headers).get("cred") === "player-credential") {
            await mapsReady(target);
            return Response.json({ code: 10000, message: "Credential rejected" });
          }
          expect(new Headers(init?.headers).get("cred")).toBe("replacement-credential");
          return Response.json({
            code: 0,
            data: [{ id: "account-recovered-mark", isUserMarked: true }],
          });
      }
    });
    const response = await request("/sync/v1/official");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ markedIds: ["account-recovered-mark"] });
    const stored = storedBinding()!;
    expect(await decryptSecret(String(stored.cred_enc), testAuthConfig.BETTER_AUTH_SECRET)).toBe(
      "replacement-credential",
    );
    expect(await decryptSecret(String(stored.token_enc), testAuthConfig.BETTER_AUTH_SECRET)).toBe(
      "replacement-signing-token",
    );
    expect(
      await decryptSecret(String(stored.account_token_enc), testAuthConfig.BETTER_AUTH_SECRET),
    ).toBe("external-account-token");
  });

  it("requires rebinding for an expired game login without replacing the stored account", async () => {
    await bind("owner", talosRole, "token");
    const previous = storedBinding();
    const mapsReady = bothMapRequests();
    external.mockImplementation(async (url) => {
      const target = new URL(String(url));
      expect(target.pathname).toBe("/web/v1/game/endfield/map/mark/list");
      await mapsReady(target);
      return Response.json({ code: 10002, message: "Game login expired" });
    });
    const response = await request("/sync/v1/official");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      code: "ENDFIELD_CREDENTIAL_REJECTED",
      details: { upstreamCode: 10002 },
    });
    expect(storedBinding()).toEqual(previous);
  });

  it("recovers rejected credentials, persists their replacement, and uses them on later syncs", async () => {
    await bind();
    const mapsReady = bothMapRequests();
    external.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      if (target.pathname === "/web/v1/auth/refresh") {
        expect(new Headers(init?.headers).get("cred")).toBe("player-credential");
        return Response.json({
          code: 0,
          data: { cred: "renewed-credential", token: "renewed-signing-token" },
        });
      }
      expect(target.pathname).toBe("/web/v1/game/endfield/map/mark/list");
      if (new Headers(init?.headers).get("cred") === "player-credential") {
        await mapsReady(target);
        return Response.json({ code: 10000, message: "Credential needs refresh" });
      }
      expect(new Headers(init?.headers).get("cred")).toBe("renewed-credential");
      return Response.json({ code: 0, data: [{ id: "recovered-mark", isUserMarked: true }] });
    });
    const recovered = await request("/sync/v1/official");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      markedIds: ["recovered-mark"],
      binding: { enabled: true, roleId: "talos-role" },
    });
    const stored = storedBinding()!;
    expect(await decryptSecret(String(stored.cred_enc), testAuthConfig.BETTER_AUTH_SECRET)).toBe(
      "renewed-credential",
    );
    expect(await decryptSecret(String(stored.token_enc), testAuthConfig.BETTER_AUTH_SECRET)).toBe(
      "renewed-signing-token",
    );
    const next = await request("/sync/v1/official");
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ markedIds: ["recovered-mark"] });
  });

  it("reads fresh marks for each caller's bound role without sharing private progress", async () => {
    await bind();
    await bind("neighbor", wulingRole);
    let ownerMarked = true;
    external.mockImplementation(async (url, init) => {
      const target = new URL(String(url));
      expect(target.pathname).toBe("/web/v1/game/endfield/map/mark/list");
      expect(new Headers(init?.headers).get("cred")).toBe("player-credential");
      const owner = target.searchParams.get("roleId") === "talos-role";
      expect(target.searchParams.get("serverId")).toBe(owner ? "1" : "2");
      return Response.json({
        code: 0,
        data:
          target.searchParams.get("mapId") === "map01"
            ? [
                {
                  id: owner ? "owner-mark" : "neighbor-mark",
                  isUserMarked: owner ? ownerMarked : true,
                },
              ]
            : [],
      });
    });
    for (const [uid, markedIds] of [
      ["owner", ["owner-mark"]],
      ["neighbor", ["neighbor-mark"]],
    ] as const) {
      const response = await request("/sync/v1/official", undefined, uid);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({
        binding: { roleId: uid === "owner" ? "talos-role" : "wuling-role" },
        markedIds,
      });
    }
    ownerMarked = false;
    expect(await (await request("/sync/v1/official")).json()).toMatchObject({ markedIds: [] });
    expect(storedBinding()).toMatchObject({ status: "enabled", role_id: "talos-role" });
    expect(storedBinding("neighbor")).toMatchObject({ status: "enabled", role_id: "wuling-role" });
  });

  it("normalizes nested marks from both maps and maps known marked hashes to unique local points", async () => {
    await bind();
    const map01 = {
      regions: [
        { marker: { id: "MARK-A", isUserMarked: true } },
        { id: 42, isUserMarked: true },
        { id: "mark-b", isUserMarked: false },
        { id: "invalid-flag", isUserMarked: "true" },
        { id: "no-flag" },
        null,
        17,
      ],
    };
    const map02 = {
      nested: {
        entries: [
          { id: "MARK-A", isUserMarked: true },
          { marker: { id: "unknown-marker", isUserMarked: true } },
          { marker: { id: "mark-a", isUserMarked: true } },
        ],
      },
    };
    upstreamMaps(map01, map02);
    const response = await request("/sync/v1/official");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      binding: {
        bound: true,
        enabled: true,
        provider: "skland",
        serverId: 1,
        roleId: "talos-role",
        nickname: "Talos Explorer",
        serverName: "Talos",
        updatedAt: expect.any(String),
      },
      timestamp: expect.any(String),
      markedIds: ["MARK-A", "42", "unknown-marker", "mark-a"],
      // Case variants identify one local point; unknown provider marks remain in markedIds.
      pointIds: ["point-a"],
      markers: [
        { id: "MARK-A", isUserMarked: true },
        { id: "42", isUserMarked: true },
        { id: "mark-b", isUserMarked: false },
        { id: "MARK-A", isUserMarked: true },
        { id: "unknown-marker", isUserMarked: true },
        { id: "mark-a", isUserMarked: true },
      ],
      raw: { map01: { code: 0, data: map01 }, map02: { code: 0, data: map02 } },
    });
    expect(storedBinding()).toMatchObject({ role_id: "talos-role", status: "enabled" });
  });
});

describe("binding ownership and lifecycle through HTTP", () => {
  it("switches warmed locator and sync reads to a newly selected role", async () => {
    await bind();
    expect((await request("/locator/position")).status).toBe(200);
    upstreamMaps([{ id: "old-role-mark", isUserMarked: true }]);
    expect((await request("/sync/v1/official")).status).toBe(200);
    await bind("owner", wulingRole);
    const newPosition = { ...position, pos: { x: 700, y: 0, z: 100 }, levelId: "wuling-factory" };
    positionFetch.mockImplementation(async (request) => {
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        roleId: "wuling-role",
        serverId: "2",
      });
      return Response.json({ code: 0, data: newPosition });
    });
    const located = await request("/locator/position?binding=1");
    expect(located.status).toBe(200);
    expect(await located.json()).toMatchObject({
      data: newPosition,
      binding: { roleId: "wuling-role", serverId: 2 },
    });
    external.mockImplementation(async (url) => {
      const target = new URL(String(url));
      expect(target.searchParams.get("roleId")).toBe("wuling-role");
      expect(target.searchParams.get("serverId")).toBe("2");
      return Response.json({ code: 0, data: [{ id: "new-role-mark", isUserMarked: true }] });
    });
    const synced = await request("/sync/v1/official");
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({
      markedIds: ["new-role-mark"],
      binding: { roleId: "wuling-role", serverId: 2 },
    });
    expect(storedBinding()).toMatchObject({
      role_id: "wuling-role",
      server_id: 2,
      status: "enabled",
    });
  });

  it("keeps the current binding and pending selection when the provider rejects a new account token", async () => {
    await bind();
    const previous = storedBinding();
    const flowId = await startFlow("owner", [wulingRole]);
    external.mockResolvedValueOnce(Response.json({ status: 1, msg: "Account token rejected" }));
    await expectError(
      await request("/binding/v1/endfield/exchange-token", {
        provider: "skland",
        token: "rejected-account-token",
        deviceId,
      }),
      401,
      "ENDFIELD_AUTH_REJECTED",
    );
    expect(storedBinding()).toEqual(previous);
    expect((await selectRole(flowId, wulingRole)).status).toBe(200);
    expect(storedBinding()).toMatchObject({ role_id: "wuling-role", status: "enabled" });
  });

  it("leaves the current binding usable when a replacement flow expires", async () => {
    await bind();
    const previous = storedBinding();
    const flowId = await startFlow("owner", [wulingRole]);
    const expiresAt = Math.max(...[...boundary.pending.values()].map((record) => record.expiresAt));
    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    await expectError(await selectRole(flowId, wulingRole), 410, "ENDFIELD_BINDING_FLOW_EXPIRED");
    expect(storedBinding()).toEqual(previous);
    const response = await request("/locator/position?binding=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: position,
      binding: { enabled: true, roleId: "talos-role", serverId: 1 },
    });
  });

  it("binds only an offered role for the signed-in owner and consumes that owner's flow", async () => {
    const flowId = await startFlow();
    await expectError(
      await selectRole(flowId, wulingRole, "neighbor"),
      410,
      "ENDFIELD_BINDING_FLOW_EXPIRED",
    );
    await expectError(
      await selectRole(flowId, { ...wulingRole, serverId: 1 }),
      404,
      "ENDFIELD_ROLE_NOT_FOUND",
    );
    expect(storedBinding()).toBeUndefined();
    expect(storedBinding("neighbor")).toBeUndefined();

    const selected = await selectRole(flowId, wulingRole);
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({
      ok: true,
      binding: {
        bound: true,
        enabled: true,
        provider: "skland",
        serverId: 2,
        roleId: "wuling-role",
        nickname: "Wuling Explorer",
        serverName: "Wuling",
        updatedAt: expect.any(String),
      },
    });
    const stored = storedBinding()!;
    expect(stored).toMatchObject({
      uid: "owner",
      role_id: "wuling-role",
      server_id: 2,
      status: "enabled",
      account_token_enc: null,
    });
    expect(await decryptSecret(String(stored.cred_enc), testAuthConfig.BETTER_AUTH_SECRET)).toBe(
      "player-credential",
    );
    expect(await decryptSecret(String(stored.token_enc), testAuthConfig.BETTER_AUTH_SECRET)).toBe(
      "player-signing-token",
    );
    await expectError(await selectRole(flowId), 410, "ENDFIELD_BINDING_FLOW_EXPIRED");
    expect(storedBinding()).toEqual(stored);
  });

  it.each(["disable", "unlink"])(
    "%s immediately revokes warmed position and official-mark access without affecting another owner",
    async (action) => {
      await bind("neighbor", wulingRole);
      await bind();
      expect((await request("/locator/position")).status).toBe(200);
      upstreamMaps();
      expect((await request("/sync/v1/official")).status).toBe(200);
      expect((await request("/locator/position", undefined, "neighbor")).status).toBe(200);

      const changed = await request(`/binding/v1/endfield/${action}`, {});
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({
        ok: true,
        binding: { bound: action === "disable", enabled: false },
      });
      if (action === "disable") {
        expect(storedBinding()).toMatchObject({ role_id: "talos-role", status: "disabled" });
      } else {
        expect(storedBinding()).toBeUndefined();
      }
      const status = action === "disable" ? 409 : 404;
      const code =
        action === "disable" ? "ENDFIELD_BINDING_DISABLED" : "ENDFIELD_BINDING_NOT_FOUND";
      for (const path of ["/locator/position", "/sync/v1/official"]) {
        await expectError(await request(path), status, code);
      }
      await expectError(await request("/locator/agree-policy", {}), status, code);
      expect(await (await request("/locator/position", undefined, "neighbor")).json()).toEqual({
        data: position,
      });
      expect(storedBinding("neighbor")).toMatchObject({
        role_id: "wuling-role",
        status: "enabled",
      });

      await bind("owner", wulingRole);
      const newPosition = { ...position, pos: { x: -12, y: 0, z: 200 }, levelId: "wuling-valley" };
      positionFetch.mockResolvedValueOnce(Response.json({ code: 0, data: newPosition }));
      const rebound = await request("/locator/position?binding=1");
      expect(rebound.status).toBe(200);
      expect(await rebound.json()).toMatchObject({
        data: newPosition,
        binding: { bound: true, enabled: true, roleId: "wuling-role", serverId: 2 },
      });
      expect(storedBinding()).toMatchObject({ role_id: "wuling-role", status: "enabled" });
    },
  );
});

describe("locator policy authorization through HTTP", () => {
  it("reports provider consent failures without losing the binding and allows a later retry", async () => {
    await bind();
    const previous = storedBinding();
    external.mockResolvedValueOnce(Response.json({ code: 401, message: "Consent rejected" }));
    await expectError(
      await request("/locator/agree-policy", {}),
      401,
      "ENDFIELD_CREDENTIAL_REJECTED",
    );
    expect(storedBinding()).toEqual(previous);
    external.mockImplementation(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/web/v1/game/endfield/map/agree-policy");
      expect(JSON.parse(String(init?.body))).toEqual({ roleId: "talos-role", serverId: "1" });
      return Response.json({ code: 0 });
    });
    const retried = await request("/locator/agree-policy", {});
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      ok: true,
      binding: { enabled: true, roleId: "talos-role" },
    });
    expect(storedBinding()).toEqual(previous);
  });

  it("rejects another role, another server, and invalid consent targets before contacting the provider", async () => {
    await bind();
    await bind("neighbor", wulingRole);
    const previous = storedBinding();
    external.mockClear();
    for (const payload of [{ roleId: "wuling-role" }, { serverId: 2 }]) {
      await expectError(
        await request("/locator/agree-policy", payload),
        409,
        "ENDFIELD_BINDING_MISMATCH",
      );
    }
    for (const payload of [{ roleId: "" }, { serverId: 0 }]) {
      await expectError(await request("/locator/agree-policy", payload), 422, "VALIDATION_ERROR");
    }
    expect(external).not.toHaveBeenCalled();
    expect(storedBinding()).toEqual(previous);
    expect(storedBinding("neighbor")).toMatchObject({ role_id: "wuling-role", status: "enabled" });
  });

  it("authorizes the owner's selected role with its stored credentials and returns a public summary", async () => {
    await bind("owner", wulingRole);
    const previous = storedBinding();
    external.mockImplementation(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/web/v1/game/endfield/map/agree-policy");
      expect(JSON.parse(String(init?.body))).toEqual({ roleId: "wuling-role", serverId: "2" });
      expect(new Headers(init?.headers).get("cred")).toBe("player-credential");
      return Response.json({ code: 0 });
    });
    const response = await request("/locator/agree-policy", {
      roleId: "wuling-role",
      serverId: "2",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      binding: {
        bound: true,
        enabled: true,
        provider: "skland",
        serverId: 2,
        roleId: "wuling-role",
        nickname: "Wuling Explorer",
        serverName: "Wuling",
        updatedAt: expect.any(String),
      },
    });
    expect(storedBinding()).toEqual(previous);
  });
});

describe("private locator access through HTTP", () => {
  it("issues a private socket ticket with position and rejects tampered or expired tickets before upgrade", async () => {
    await bind();
    const response = await request("/locator/position?socket_ticket=1&binding=true");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = (await response.json()) as { socketTicket: string };
    expect(result).toEqual({
      data: position,
      socketTicket: expect.any(String),
      binding: {
        bound: true,
        enabled: true,
        provider: "skland",
        serverId: 1,
        roleId: "talos-role",
        nickname: "Talos Explorer",
        serverName: "Talos",
        updatedAt: expect.any(String),
      },
    });
    await expectError(await request("/locator/position-stream"), 426, "WEBSOCKET_REQUIRED");
    const middle = Math.floor(result.socketTicket.length / 2);
    const changedTicket =
      result.socketTicket.slice(0, middle) +
      (result.socketTicket[middle] === "A" ? "B" : "A") +
      result.socketTicket.slice(middle + 1);
    for (const ticket of ["invalid-ticket", changedTicket]) {
      await expectError(
        await request(
          `/locator/position-stream?ticket=${encodeURIComponent(ticket)}`,
          undefined,
          "",
          { upgrade: "websocket" },
        ),
        401,
        "LOCATOR_SOCKET_TICKET_INVALID",
      );
    }
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
    await expectError(
      await request(
        `/locator/position-stream?ticket=${encodeURIComponent(result.socketTicket)}`,
        undefined,
        "",
        { upgrade: "websocket" },
      ),
      401,
      "LOCATOR_SOCKET_TICKET_INVALID",
    );
    expect(storedBinding()).toMatchObject({ role_id: "talos-role", status: "enabled" });
  });

  it("keeps cached positions scoped to the authenticated owner and supports query-token clients", async () => {
    await bind();
    await bind("neighbor", wulingRole);
    const neighborPosition = {
      ...position,
      pos: { x: 900, y: 10, z: 250 },
      levelId: "wuling-city",
    };
    positionFetch.mockImplementation(async (request) => {
      expect(request.headers.get("cred")).toBe("player-credential");
      return Response.json({
        code: 0,
        data:
          new URL(request.url).searchParams.get("roleId") === "talos-role"
            ? position
            : neighborPosition,
      });
    });
    const ownerToken = sessions.get("owner")!.headers.authorization.slice(7);
    const queryClient = await request(
      `/locator/position?access_token=${ownerToken}`,
      undefined,
      "",
    );
    expect(queryClient.status).toBe(200);
    expect(queryClient.headers.get("cache-control")).toBe("private, no-store");
    expect(await queryClient.json()).toEqual({ data: position });
    const neighbor = await request("/locator/position?includeBinding=true", undefined, "neighbor");
    expect(neighbor.status).toBe(200);
    expect(await neighbor.json()).toMatchObject({
      data: neighborPosition,
      binding: { roleId: "wuling-role", serverId: 2 },
    });
    const neighborToken = sessions.get("neighbor")!.headers.authorization.slice(7);
    // The authenticated header takes precedence over the query token, even when
    // that token belongs to another owner with an already-warmed position cache.
    const headerClient = await request(`/locator/position?access_token=${neighborToken}`);
    expect(headerClient.status).toBe(200);
    expect(headerClient.headers.get("x-locator-cache")).toBe("fresh");
    expect(await headerClient.json()).toEqual({ data: position });
  });

  it("requires a session and an enabled binding before exposing progress, position, or policy authorization", async () => {
    await bind();
    external.mockClear();
    for (const [path, payload] of [
      ["/binding/v1/endfield/status", undefined],
      ["/binding/v1/endfield/disable", {}],
      ["/binding/v1/endfield/unlink", {}],
      ["/sync/v1/official", undefined],
      ["/locator/position?socket_ticket=1", undefined],
      ["/locator/agree-policy", {}],
    ] as const) {
      await expectError(await request(path, payload, ""), 401, "SESSION_REQUIRED");
    }
    for (const [path, payload] of [
      ["/sync/v1/official", undefined],
      ["/locator/position?socket_ticket=1", undefined],
      ["/locator/agree-policy", {}],
    ] as const) {
      await expectError(
        await request(path, payload, "neighbor"),
        404,
        "ENDFIELD_BINDING_NOT_FOUND",
      );
    }
    expect(external).not.toHaveBeenCalled();
    expect(positionFetch).not.toHaveBeenCalled();
    expect(storedBinding()).toMatchObject({ role_id: "talos-role", status: "enabled" });
    expect(storedBinding("neighbor")).toBeUndefined();
  });
});
