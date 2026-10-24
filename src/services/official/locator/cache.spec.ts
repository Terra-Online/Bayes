import { describe, expect, it } from "vitest";

import type { Bindings } from "@/types/app";

import { getLocatorCache, readPositionCache, writePositionCache } from "./cache";

const position = { pos: { x: 1, y: 2, z: 3 }, isOnline: true, mapId: "map", levelId: "level" };
const env = () => ({ DB: {}, ENDFIELD_CREDENTIAL_SECRET: "test-secret" }) as Bindings;
describe("completed locator caches", () => {
  it("isolates completed values by database, secret and upstream configuration", () => {
    const first = env();
    const second = env();
    writePositionCache(first, "user:role", { data: position, refreshedAt: 0 });
    expect(readPositionCache(second, "user:role")).toBeUndefined();
    expect(readPositionCache(first, "user:role")).toBeDefined();
    first.ENDFIELD_WS_BASE_URL = "https://other.example";
    expect(readPositionCache(first, "user:role")).toBeUndefined();
    writePositionCache(first, "user:role", { data: position, refreshedAt: 0 });
    first.ENDFIELD_CREDENTIAL_SECRET = "rotated-secret";
    expect(readPositionCache(first, "user:role")).toBeUndefined();
  });

  it("bounds retained completed entries without extending their freshness window", () => {
    const bindings = env();
    for (let index = 0; index < 1001; index++) {
      writePositionCache(bindings, String(index), { data: position, refreshedAt: 0 });
    }
    expect(getLocatorCache(bindings).positions.size).toBe(1000);
    expect(readPositionCache(bindings, "0")).toBeUndefined();
    expect(readPositionCache(bindings, "1000")?.refreshedAt).toBe(0);
  });
});
