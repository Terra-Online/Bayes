import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getEndfieldPosition, getEndfieldWebSocketToken } from "./positionSocket";

const account = {
  provider: "skport" as const,
  roleId: "player-role",
  serverId: 2,
  cred: "player-cred",
  token: "signing-token",
};
let gameFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  gameFetch = vi.fn<typeof fetch>(() => {
    throw new Error("Unconfigured game request");
  });
  vi.stubGlobal("fetch", gameFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("normalizes the provider's HTTP coordinates and sends the selected Skport role", async () => {
  gameFetch.mockImplementationOnce(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://zonai.skport.com");
    expect(url.pathname).toBe("/web/v1/game/endfield/map/me/position");
    expect(Object.fromEntries(url.searchParams)).toEqual({ roleId: "player-role", serverId: "2" });
    expect(request.headers.get("cred")).toBe("player-cred");
    expect(request.headers.get("origin")).toBe("https://game.skport.com");
    return Response.json({
      code: 0,
      data: { pos: { x: "12.5", z: "-4" }, levelId: "outpost", isOnline: true, mapId: "map01" },
    });
  });
  expect(await getEndfieldPosition(account)).toEqual({
    pos: { x: 12.5, y: 0, z: -4 },
    levelId: "outpost",
    isOnline: true,
    mapId: "map01",
  });
});

it("rejects an incomplete WebSocket grant and can obtain a later valid token", async () => {
  gameFetch.mockResolvedValueOnce(Response.json({ code: 0, data: {} }));
  await expect(getEndfieldWebSocketToken(account)).rejects.toMatchObject({
    status: 502,
    code: "ENDFIELD_POSITION_SOCKET_TOKEN_MISSING",
  });
  gameFetch.mockResolvedValueOnce(Response.json({ code: 0, data: { token: "socket-grant" } }));
  await expect(getEndfieldWebSocketToken(account)).resolves.toBe("socket-grant");
});

it.each([
  { upstreamCode: 10002, status: 401, code: "ENDFIELD_CREDENTIAL_REJECTED" },
  { upstreamCode: 10001, status: 502, code: "ENDFIELD_DEVICE_REJECTED" },
  { upstreamCode: 9000, status: 401, code: "ENDFIELD_POSITION_UNAVAILABLE" },
])(
  "preserves $code from HTTP without opening an unnecessary socket",
  async ({ upstreamCode, status, code }) => {
    gameFetch.mockResolvedValueOnce(Response.json({ code: upstreamCode }));
    await expect(getEndfieldPosition(account)).rejects.toMatchObject({
      status,
      code,
      details: { upstreamCode },
    });
    // Credential/device/login errors require different user recovery; socket fallback
    // is reserved for upstream availability failures.
    expect(gameFetch).toHaveBeenCalledOnce();
  },
);

it("reports both availability failures after malformed HTTP position and allows a later read", async () => {
  gameFetch
    .mockResolvedValueOnce(
      Response.json({
        code: 0,
        data: { pos: { x: "", z: 2 }, levelId: "outpost", isOnline: true, mapId: "map01" },
      }),
    )
    .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
  await expect(getEndfieldPosition(account)).rejects.toMatchObject({
    status: 502,
    code: "ENDFIELD_POSITION_UPSTREAM_UNAVAILABLE",
    details: { httpCode: "ENDFIELD_BAD_RESPONSE", socketCode: "ENDFIELD_BAD_RESPONSE" },
  });
  gameFetch.mockResolvedValueOnce(
    Response.json({
      code: 0,
      data: { pos: { x: 3, y: 0, z: 8 }, levelId: "outpost", isOnline: true, mapId: "map01" },
    }),
  );
  expect(await getEndfieldPosition(account)).toEqual({
    pos: { x: 3, y: 0, z: 8 },
    levelId: "outpost",
    isOnline: true,
    mapId: "map01",
  });
});
