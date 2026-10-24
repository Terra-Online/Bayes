import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptSecret } from "@/lib/crypto";
import { testAuthConfig } from "@/test/fixtures/auth";
import {
  createEndfieldHttpFixture,
  type EndfieldHttpFixture,
  talosRole,
  wulingRole,
} from "@/test/fixtures/endfieldHttp";

const boundary = vi.hoisted(() => ({
  pending: new Map<string, { value: unknown; expiresAt: number }>(),
}));

// Substitute lookup data while keeping the official-marks application service real.
vi.mock("@/services/official/officialMarkerHashToPointId.json", () => ({
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
    await fixture.bind("owner", talosRole, "token");
    const mapsReady = bothMapRequests();
    fixture.external.mockImplementation(async (url, init) => {
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
    const response = await fixture.request("/sync/v1/official");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ markedIds: ["account-recovered-mark"] });
    const stored = fixture.storedBinding()!;
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
    await fixture.bind("owner", talosRole, "token");
    const previous = fixture.storedBinding();
    const mapsReady = bothMapRequests();
    fixture.external.mockImplementation(async (url) => {
      const target = new URL(String(url));
      expect(target.pathname).toBe("/web/v1/game/endfield/map/mark/list");
      await mapsReady(target);
      return Response.json({ code: 10002, message: "Game login expired" });
    });
    const response = await fixture.request("/sync/v1/official");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      code: "ENDFIELD_CREDENTIAL_REJECTED",
      details: { upstreamCode: 10002 },
    });
    expect(fixture.storedBinding()).toEqual(previous);
  });

  it("recovers rejected credentials, persists their replacement, and uses them on later syncs", async () => {
    await fixture.bind();
    const mapsReady = bothMapRequests();
    fixture.external.mockImplementation(async (url, init) => {
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
    const recovered = await fixture.request("/sync/v1/official");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      markedIds: ["recovered-mark"],
      binding: { enabled: true, roleId: "talos-role" },
    });
    const stored = fixture.storedBinding()!;
    expect(await decryptSecret(String(stored.cred_enc), testAuthConfig.BETTER_AUTH_SECRET)).toBe(
      "renewed-credential",
    );
    expect(await decryptSecret(String(stored.token_enc), testAuthConfig.BETTER_AUTH_SECRET)).toBe(
      "renewed-signing-token",
    );
    const next = await fixture.request("/sync/v1/official");
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ markedIds: ["recovered-mark"] });
  });

  it("reads fresh marks for each caller's bound role without sharing private progress", async () => {
    await fixture.bind();
    await fixture.bind("neighbor", wulingRole);
    let ownerMarked = true;
    fixture.external.mockImplementation(async (url, init) => {
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
      const response = await fixture.request("/sync/v1/official", undefined, uid);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({
        binding: { roleId: uid === "owner" ? "talos-role" : "wuling-role" },
        markedIds,
      });
    }
    ownerMarked = false;
    expect(await (await fixture.request("/sync/v1/official")).json()).toMatchObject({
      markedIds: [],
    });
    expect(fixture.storedBinding()).toMatchObject({ status: "enabled", role_id: "talos-role" });
    expect(fixture.storedBinding("neighbor")).toMatchObject({
      status: "enabled",
      role_id: "wuling-role",
    });
  });

  it("normalizes nested marks from both maps and maps known marked hashes to unique local points", async () => {
    await fixture.bind();
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
    fixture.upstreamMaps(map01, map02);
    const response = await fixture.request("/sync/v1/official");
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
    expect(fixture.storedBinding()).toMatchObject({ role_id: "talos-role", status: "enabled" });
  });
});
