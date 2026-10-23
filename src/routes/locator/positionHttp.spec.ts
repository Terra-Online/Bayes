import { Hono, type ExecutionContext } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/createAuth";
import { encryptSecret } from "@/lib/crypto";
import { createEndfieldDeviceProfile } from "@/lib/endfieldClient/deviceProfile";
import { onAppError } from "@/middleware/error-handler";
import { requestIdMiddleware } from "@/middleware/request-id";
import { saveBinding, saveRoleDeviceProfile } from "@/repositories/binding/repository";
import { POSITION_CACHE_FRESH_MS } from "@/services/locator/cache";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type AuthenticatedUserFixture } from "@/test/fixtures/auth";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes } from "./positionRoutes";

let database: TestDatabase;
let env: Bindings;
let owner: AuthenticatedUserFixture;
let gameFetch: ReturnType<typeof vi.fn<typeof fetch>>;
let background: Promise<unknown>[];
let app: Hono<AppEnv<{ requestId: string }>>;

const position = { pos: { x: 1, y: 0, z: 2 }, levelId: "outpost", isOnline: true, mapId: "map01" };
const nextPosition = { ...position, pos: { x: 30, y: 0, z: 40 } };

beforeEach(async () => {
  database = createTestDatabase();
  owner = insertAuthenticatedUser(database.sqlite, { uid: "owner" });
  env = createMockBindings({ DB: database.db }).bindings;
  await saveBinding(
    database.db,
    "owner",
    "skland",
    {
      roleId: "role",
      serverId: 1,
      nickname: "Explorer",
      serverName: "Talos",
      serverType: "official",
      level: 1,
      isDefault: true,
    },
    {
      cred: await encryptSecret("credential", env.BETTER_AUTH_SECRET!),
      token: await encryptSecret("token", env.BETTER_AUTH_SECRET!),
    },
  );
  await saveRoleDeviceProfile(
    database.db,
    "role",
    createEndfieldDeviceProfile("browser-device-id-1234567890"),
  );
  gameFetch = vi.fn<typeof fetch>(() => {
    throw new Error("Unconfigured game request");
  });
  vi.stubGlobal("fetch", gameFetch);
  background = [];
  app = new Hono<AppEnv<{ requestId: string }>>()
    .use("*", requestIdMiddleware)
    .onError(onAppError)
    .route("/locator", createRoutes());
});
afterEach(async () => {
  await Promise.all(background);
  database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function request(query = ""): Promise<Response> {
  const ctx: ExecutionContext = {
    waitUntil: (promise) => {
      background.push(promise);
    },
    passThroughOnException() {},
    props: {},
  };
  return runWithAuthRequest(() =>
    app.request(`http://localhost/locator/position${query}`, { headers: owner.headers }, env, ctx),
  );
}

it("serves a stale position while the game is pending, then serves the completed refresh privately", async () => {
  gameFetch.mockResolvedValueOnce(Response.json({ code: 0, data: position }));
  const cold = await request();
  expect(cold.status).toBe(200);
  expect(cold.headers.get("x-locator-cache")).toBe("miss");
  expect(await cold.json()).toEqual({ data: position });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + POSITION_CACHE_FRESH_MS + 1);
  let releaseGameRefresh!: (value: Response) => void;
  gameFetch.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      releaseGameRefresh = resolve;
    }),
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const stale = await Promise.race([
      request("?binding=1&socket_ticket=1"),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Stale read blocked behind game refresh")),
          1500,
        );
      }),
    ]);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe("private, no-store");
    expect(stale.headers.get("x-locator-cache")).toBe("stale");
    expect(await stale.json()).toMatchObject({
      data: position,
      binding: { roleId: "role" },
      socketTicket: expect.any(String),
    });
    releaseGameRefresh(Response.json({ code: 0, data: nextPosition }));
    await Promise.all(background);
    const fresh = await request();
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("x-locator-cache")).toBe("fresh");
    expect(await fresh.json()).toEqual({ data: nextPosition });
    expect(
      database.sqlite
        .prepare("SELECT role_id, status FROM endfield_bindings WHERE uid = 'owner'")
        .get(),
    ).toMatchObject({ role_id: "role", status: "enabled" });
  } finally {
    // Unblock teardown even when an assertion fails while the provider is held.
    clearTimeout(deadline);
    releaseGameRefresh(Response.json({ code: 0, data: nextPosition }));
  }
});

it("keeps the last position and binding after background failure and refreshes on a later request", async () => {
  gameFetch.mockResolvedValueOnce(Response.json({ code: 0, data: position }));
  expect((await request()).status).toBe(200);
  const before = database.sqlite.prepare("SELECT * FROM endfield_bindings").get();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + POSITION_CACHE_FRESH_MS + 1);
  // Exhaust both HTTP and socket-grant fallback so this exercises a failed refresh.
  gameFetch
    .mockResolvedValueOnce(Response.json({ code: 1 }, { status: 503 }))
    .mockResolvedValueOnce(new Response("gateway unavailable", { status: 502 }));
  const stale = await request();
  expect(stale.status).toBe(200);
  expect(await stale.json()).toEqual({ data: position });
  await Promise.all(background);
  expect(database.sqlite.prepare("SELECT * FROM endfield_bindings").get()).toEqual(before);
  gameFetch.mockResolvedValueOnce(Response.json({ code: 0, data: nextPosition }));
  const retry = await request();
  expect(retry.headers.get("x-locator-cache")).toBe("stale");
  expect(await retry.json()).toEqual({ data: position });
  await Promise.all(background);
  const recovered = await request();
  expect(recovered.headers.get("x-locator-cache")).toBe("fresh");
  expect(await recovered.json()).toEqual({ data: nextPosition });
  expect(database.sqlite.prepare("SELECT * FROM endfield_bindings").get()).toEqual(before);
});
