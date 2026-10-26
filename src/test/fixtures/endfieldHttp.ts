import type { StatementSync } from "node:sqlite";

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { expect, vi, type Mock } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { createRoutes as bindingRoutes } from "@/routes/binding/createRoutes";
import { createRoutes as locatorRoutes } from "@/routes/locator/createRoutes";
import { createRoutes as positionRoutes } from "@/routes/locator/positionRoutes";
import { createRoutes as syncRoutes } from "@/routes/sync/createRoutes";
import type { EndfieldRoleOption } from "@/services/official/client/types";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { AppEnv, Bindings } from "@/types/app";

import { insertAuthUser, insertSession, testAuthConfig } from "./auth";
import { insertUser } from "./users";

export type PendingEndfieldFlows = Map<string, { value: unknown; expiresAt: number }>;
export interface EndfieldHttpFixture {
  database: TestDatabase;
  sessions: Map<string, ReturnType<typeof insertSession>>;
  external: Mock<typeof fetch>;
  positionFetch: Mock<(request: Request) => Promise<Response>>;
  request(
    path: string,
    payload?: unknown,
    uid?: string,
    headers?: Record<string, string>,
  ): Response | Promise<Response>;
  startFlow(uid?: string, roles?: EndfieldRoleOption[], kind?: "code" | "token"): Promise<string>;
  selectRole(flowId: string, role?: EndfieldRoleOption, uid?: string): Response | Promise<Response>;
  bind(uid?: string, role?: EndfieldRoleOption, kind?: "code" | "token"): Promise<void>;
  expectError(response: Response, status: number, code: string): Promise<void>;
  storedBinding(uid?: string): ReturnType<StatementSync["get"]>;
  upstreamMaps(map01?: unknown, map02?: unknown): void;
}
export const talosRole: EndfieldRoleOption = {
  serverId: 1,
  roleId: "talos-role",
  nickname: "Talos Explorer",
  level: 20,
  serverType: "official",
  serverName: "Talos",
  isDefault: true,
};
export const wulingRole: EndfieldRoleOption = {
  ...talosRole,
  serverId: 2,
  roleId: "wuling-role",
  nickname: "Wuling Explorer",
  serverName: "Wuling",
  isDefault: false,
};
export const deviceId = "binding-browser-device-12345678";
export const position = {
  pos: { x: 125, y: 4, z: -80 },
  isOnline: true,
  mapId: "map01",
  levelId: "talos-outpost",
};
export function createEndfieldHttpFixture(pending: PendingEndfieldFlows): EndfieldHttpFixture {
  const external = vi.fn<typeof fetch>();
  const positionFetch = vi.fn<(request: Request) => Promise<Response>>();

  const database = createTestDatabase();
  const sessions = new Map<string, ReturnType<typeof insertSession>>();
  for (const uid of ["owner", "neighbor"]) {
    insertUser(database.sqlite, { uid });
    insertAuthUser(database.sqlite, { id: uid });
    sessions.set(uid, insertSession(database.sqlite, { userId: uid }));
  }
  const env = {
    DB: database.db,
    ...testAuthConfig,
    OEM_BINDING_RATE_LIMIT: { limit: async () => ({ success: true }) },
  } as unknown as Bindings;
  const app = new Hono<AppEnv<{ requestId: string }>>()
    .use(
      "*",
      createMiddleware<AppEnv<{ requestId: string }>>(async (c, next) => {
        c.set("requestId", "endfield-lifecycle");
        await next();
      }),
    )
    .onError(onAppError)
    .route("/binding/v1", bindingRoutes())
    .route("/sync/v1", syncRoutes())
    .route("/locator", positionRoutes())
    .route("/locator", locatorRoutes());
  pending.clear();
  positionFetch.mockImplementation(async () => Response.json({ code: 0, data: position }));
  external.mockImplementation(async (url) => {
    throw new Error(`Unexpected external request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return new URL(request.url).pathname === "/web/v1/game/endfield/map/me/position"
      ? positionFetch(request)
      : external(input, init);
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
  return {
    database,
    sessions,
    external,
    positionFetch,
    request,
    startFlow,
    selectRole,
    bind,
    expectError,
    storedBinding,
    upstreamMaps,
  };
}
