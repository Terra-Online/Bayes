import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { agreePolicy, getEndfieldMapMarkList } from "./mapClient";

const account = {
  provider: "skport" as const,
  roleId: "international-role",
  serverId: 2,
  cred: "international-credential",
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

it("reads the selected international role's map from Skport with its game origin", async () => {
  const marks = { code: 0, data: [{ id: "international-mark", isUserMarked: true }] };
  gameFetch.mockImplementationOnce(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://zonai.skport.com");
    expect(url.pathname).toBe("/web/v1/game/endfield/map/mark/list");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      mapId: "map02",
      roleId: "international-role",
      serverId: "2",
    });
    expect(request.headers.get("origin")).toBe("https://game.skport.com");
    expect(request.headers.get("cred")).toBe("international-credential");
    return Response.json(marks);
  });
  expect(await getEndfieldMapMarkList({ ...account, mapId: "map02" })).toEqual(marks);
});

it("authorizes map policy for the selected Skport role without sending the signing token", async () => {
  gameFetch.mockImplementationOnce(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://zonai.skport.com/web/v1/game/endfield/map/agree-policy");
    expect(request.method).toBe("POST");
    expect(request.headers.get("origin")).toBe("https://game.skport.com");
    expect(request.headers.get("cred")).toBe("international-credential");
    request.headers.forEach((value) => expect(value).not.toContain(account.token));
    expect(await request.json()).toEqual({ roleId: "international-role", serverId: "2" });
    return Response.json({ code: 0, data: {} });
  });
  await expect(agreePolicy(account)).resolves.toBeUndefined();
});
