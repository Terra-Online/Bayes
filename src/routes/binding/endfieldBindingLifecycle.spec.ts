import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptSecret } from "@/lib/crypto";
import { testAuthConfig } from "@/test/fixtures/auth";
import {
  createEndfieldHttpFixture,
  type EndfieldHttpFixture,
  wulingRole,
  deviceId,
  position,
} from "@/test/fixtures/endfieldHttp";

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
let fixture: EndfieldHttpFixture;
beforeEach(() => {
  fixture = createEndfieldHttpFixture(boundary.pending);
});
afterEach(() => {
  fixture.database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("binding ownership and lifecycle through HTTP", () => {
  it("switches warmed locator and sync reads to a newly selected role", async () => {
    await fixture.bind();
    expect((await fixture.request("/locator/position")).status).toBe(200);
    fixture.upstreamMaps([{ id: "old-role-mark", isUserMarked: true }]);
    expect((await fixture.request("/sync/v1/official")).status).toBe(200);
    await fixture.bind("owner", wulingRole);
    const newPosition = { ...position, pos: { x: 700, y: 0, z: 100 }, levelId: "wuling-factory" };
    fixture.positionFetch.mockImplementation(async (request) => {
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        roleId: "wuling-role",
        serverId: "2",
      });
      return Response.json({ code: 0, data: newPosition });
    });
    const located = await fixture.request("/locator/position?binding=1");
    expect(located.status).toBe(200);
    expect(await located.json()).toMatchObject({
      data: newPosition,
      binding: { roleId: "wuling-role", serverId: 2 },
    });
    fixture.external.mockImplementation(async (url) => {
      const target = new URL(String(url));
      expect(target.searchParams.get("roleId")).toBe("wuling-role");
      expect(target.searchParams.get("serverId")).toBe("2");
      return Response.json({ code: 0, data: [{ id: "new-role-mark", isUserMarked: true }] });
    });
    const synced = await fixture.request("/sync/v1/official");
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({
      markedIds: ["new-role-mark"],
      binding: { roleId: "wuling-role", serverId: 2 },
    });
    expect(fixture.storedBinding()).toMatchObject({
      role_id: "wuling-role",
      server_id: 2,
      status: "enabled",
    });
  });

  it("keeps the current binding and pending selection when the provider rejects a new account token", async () => {
    await fixture.bind();
    const previous = fixture.storedBinding();
    const flowId = await fixture.startFlow("owner", [wulingRole]);
    fixture.external.mockResolvedValueOnce(
      Response.json({ status: 1, msg: "Account token rejected" }),
    );
    await fixture.expectError(
      await fixture.request("/binding/v1/endfield/exchange-token", {
        provider: "skland",
        token: "rejected-account-token",
        deviceId,
      }),
      401,
      "ENDFIELD_AUTH_REJECTED",
    );
    expect(fixture.storedBinding()).toEqual(previous);
    expect((await fixture.selectRole(flowId, wulingRole)).status).toBe(200);
    expect(fixture.storedBinding()).toMatchObject({ role_id: "wuling-role", status: "enabled" });
  });

  it("leaves the current binding usable when a replacement flow expires", async () => {
    await fixture.bind();
    const previous = fixture.storedBinding();
    const flowId = await fixture.startFlow("owner", [wulingRole]);
    const expiresAt = Math.max(...[...boundary.pending.values()].map((record) => record.expiresAt));
    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    await fixture.expectError(
      await fixture.selectRole(flowId, wulingRole),
      410,
      "ENDFIELD_BINDING_FLOW_EXPIRED",
    );
    expect(fixture.storedBinding()).toEqual(previous);
    const response = await fixture.request("/locator/position?binding=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: position,
      binding: { enabled: true, roleId: "talos-role", serverId: 1 },
    });
  });

  it("binds only an offered role for the signed-in owner and consumes that owner's flow", async () => {
    const flowId = await fixture.startFlow();
    await fixture.expectError(
      await fixture.selectRole(flowId, wulingRole, "neighbor"),
      410,
      "ENDFIELD_BINDING_FLOW_EXPIRED",
    );
    await fixture.expectError(
      await fixture.selectRole(flowId, { ...wulingRole, serverId: 1 }),
      404,
      "ENDFIELD_ROLE_NOT_FOUND",
    );
    expect(fixture.storedBinding()).toBeUndefined();
    expect(fixture.storedBinding("neighbor")).toBeUndefined();

    const selected = await fixture.selectRole(flowId, wulingRole);
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
    const stored = fixture.storedBinding()!;
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
    await fixture.expectError(
      await fixture.selectRole(flowId),
      410,
      "ENDFIELD_BINDING_FLOW_EXPIRED",
    );
    expect(fixture.storedBinding()).toEqual(stored);
  });

  it.each(["disable", "unlink"])(
    "%s immediately revokes warmed position and official-mark access without affecting another owner",
    async (action) => {
      await fixture.bind("neighbor", wulingRole);
      await fixture.bind();
      expect((await fixture.request("/locator/position")).status).toBe(200);
      fixture.upstreamMaps();
      expect((await fixture.request("/sync/v1/official")).status).toBe(200);
      expect((await fixture.request("/locator/position", undefined, "neighbor")).status).toBe(200);

      const changed = await fixture.request(`/binding/v1/endfield/${action}`, {});
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({
        ok: true,
        binding: { bound: action === "disable", enabled: false },
      });
      if (action === "disable") {
        expect(fixture.storedBinding()).toMatchObject({
          role_id: "talos-role",
          status: "disabled",
        });
      } else {
        expect(fixture.storedBinding()).toBeUndefined();
      }
      const status = action === "disable" ? 409 : 404;
      const code =
        action === "disable" ? "ENDFIELD_BINDING_DISABLED" : "ENDFIELD_BINDING_NOT_FOUND";
      for (const path of ["/locator/position", "/sync/v1/official"]) {
        await fixture.expectError(await fixture.request(path), status, code);
      }
      await fixture.expectError(await fixture.request("/locator/agree-policy", {}), status, code);
      expect(
        await (await fixture.request("/locator/position", undefined, "neighbor")).json(),
      ).toEqual({
        data: position,
      });
      expect(fixture.storedBinding("neighbor")).toMatchObject({
        role_id: "wuling-role",
        status: "enabled",
      });

      await fixture.bind("owner", wulingRole);
      const newPosition = { ...position, pos: { x: -12, y: 0, z: 200 }, levelId: "wuling-valley" };
      fixture.positionFetch.mockResolvedValueOnce(Response.json({ code: 0, data: newPosition }));
      const rebound = await fixture.request("/locator/position?binding=1");
      expect(rebound.status).toBe(200);
      expect(await rebound.json()).toMatchObject({
        data: newPosition,
        binding: { bound: true, enabled: true, roleId: "wuling-role", serverId: 2 },
      });
      expect(fixture.storedBinding()).toMatchObject({ role_id: "wuling-role", status: "enabled" });
    },
  );
});

describe("locator policy authorization through HTTP", () => {
  it("reports provider consent failures without losing the binding and allows a later retry", async () => {
    await fixture.bind();
    const previous = fixture.storedBinding();
    fixture.external.mockResolvedValueOnce(
      Response.json({ code: 401, message: "Consent rejected" }),
    );
    await fixture.expectError(
      await fixture.request("/locator/agree-policy", {}),
      401,
      "ENDFIELD_CREDENTIAL_REJECTED",
    );
    expect(fixture.storedBinding()).toEqual(previous);
    fixture.external.mockImplementation(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/web/v1/game/endfield/map/agree-policy");
      expect(JSON.parse(String(init?.body))).toEqual({ roleId: "talos-role", serverId: "1" });
      return Response.json({ code: 0 });
    });
    const retried = await fixture.request("/locator/agree-policy", {});
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      ok: true,
      binding: { enabled: true, roleId: "talos-role" },
    });
    expect(fixture.storedBinding()).toEqual(previous);
  });

  it("rejects another role or server before contacting the provider", async () => {
    await fixture.bind();
    await fixture.bind("neighbor", wulingRole);
    const previous = fixture.storedBinding();
    fixture.external.mockClear();
    for (const payload of [{ roleId: "wuling-role" }, { serverId: 2 }]) {
      await fixture.expectError(
        await fixture.request("/locator/agree-policy", payload),
        409,
        "ENDFIELD_BINDING_MISMATCH",
      );
    }
    expect(fixture.external).not.toHaveBeenCalled();
    expect(fixture.storedBinding()).toEqual(previous);
    expect(fixture.storedBinding("neighbor")).toMatchObject({
      role_id: "wuling-role",
      status: "enabled",
    });
  });

  it("authorizes the owner's selected role with its stored credentials and returns a public summary", async () => {
    await fixture.bind("owner", wulingRole);
    const previous = fixture.storedBinding();
    fixture.external.mockImplementation(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/web/v1/game/endfield/map/agree-policy");
      expect(JSON.parse(String(init?.body))).toEqual({ roleId: "wuling-role", serverId: "2" });
      expect(new Headers(init?.headers).get("cred")).toBe("player-credential");
      return Response.json({ code: 0 });
    });
    const response = await fixture.request("/locator/agree-policy", {
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
    expect(fixture.storedBinding()).toEqual(previous);
  });
});

describe("private locator access through HTTP", () => {
  it("issues a private socket ticket with position and rejects tampered or expired tickets before upgrade", async () => {
    await fixture.bind();
    const response = await fixture.request("/locator/position?socket_ticket=1&binding=true");
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
    await fixture.expectError(
      await fixture.request("/locator/position-stream"),
      426,
      "WEBSOCKET_REQUIRED",
    );
    const middle = Math.floor(result.socketTicket.length / 2);
    const changedTicket =
      result.socketTicket.slice(0, middle) +
      (result.socketTicket[middle] === "A" ? "B" : "A") +
      result.socketTicket.slice(middle + 1);
    for (const ticket of ["invalid-ticket", changedTicket]) {
      await fixture.expectError(
        await fixture.request(
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
    await fixture.expectError(
      await fixture.request(
        `/locator/position-stream?ticket=${encodeURIComponent(result.socketTicket)}`,
        undefined,
        "",
        { upgrade: "websocket" },
      ),
      401,
      "LOCATOR_SOCKET_TICKET_INVALID",
    );
    expect(fixture.storedBinding()).toMatchObject({ role_id: "talos-role", status: "enabled" });
  });

  it("keeps cached positions scoped to the authenticated owner and supports query-token clients", async () => {
    await fixture.bind();
    await fixture.bind("neighbor", wulingRole);
    const neighborPosition = {
      ...position,
      pos: { x: 900, y: 10, z: 250 },
      levelId: "wuling-city",
    };
    fixture.positionFetch.mockImplementation(async (request) => {
      expect(request.headers.get("cred")).toBe("player-credential");
      return Response.json({
        code: 0,
        data:
          new URL(request.url).searchParams.get("roleId") === "talos-role"
            ? position
            : neighborPosition,
      });
    });
    const ownerToken = fixture.sessions.get("owner")!.headers.authorization.slice(7);
    const queryClient = await fixture.request(
      `/locator/position?access_token=${ownerToken}`,
      undefined,
      "",
    );
    expect(queryClient.status).toBe(200);
    expect(queryClient.headers.get("cache-control")).toBe("private, no-store");
    expect(await queryClient.json()).toEqual({ data: position });
    const neighbor = await fixture.request(
      "/locator/position?includeBinding=true",
      undefined,
      "neighbor",
    );
    expect(neighbor.status).toBe(200);
    expect(await neighbor.json()).toMatchObject({
      data: neighborPosition,
      binding: { roleId: "wuling-role", serverId: 2 },
    });
    const neighborToken = fixture.sessions.get("neighbor")!.headers.authorization.slice(7);
    // The authenticated header takes precedence over the query token, even when
    // that token belongs to another owner with an already-warmed position cache.
    const headerClient = await fixture.request(`/locator/position?access_token=${neighborToken}`);
    expect(headerClient.status).toBe(200);
    expect(headerClient.headers.get("x-locator-cache")).toBe("fresh");
    expect(await headerClient.json()).toEqual({ data: position });
  });

  it("requires a session and an enabled binding before exposing progress, position, or policy authorization", async () => {
    await fixture.bind();
    fixture.external.mockClear();
    for (const [path, payload] of [
      ["/binding/v1/endfield/status", undefined],
      ["/binding/v1/endfield/disable", {}],
      ["/binding/v1/endfield/unlink", {}],
      ["/sync/v1/official", undefined],
      ["/locator/position?socket_ticket=1", undefined],
      ["/locator/agree-policy", {}],
    ] as const) {
      await fixture.expectError(await fixture.request(path, payload, ""), 401, "SESSION_REQUIRED");
    }
    for (const [path, payload] of [
      ["/sync/v1/official", undefined],
      ["/locator/position?socket_ticket=1", undefined],
      ["/locator/agree-policy", {}],
    ] as const) {
      await fixture.expectError(
        await fixture.request(path, payload, "neighbor"),
        404,
        "ENDFIELD_BINDING_NOT_FOUND",
      );
    }
    expect(fixture.external).not.toHaveBeenCalled();
    expect(fixture.positionFetch).not.toHaveBeenCalled();
    expect(fixture.storedBinding()).toMatchObject({ role_id: "talos-role", status: "enabled" });
    expect(fixture.storedBinding("neighbor")).toBeUndefined();
  });
});
