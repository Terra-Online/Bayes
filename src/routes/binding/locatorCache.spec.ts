import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "@/types/app";

import {
  deleteLocatorCaches,
  getLocatorCache,
  readPositionCache,
  refreshPositionCache,
  writePositionCache,
} from "./locatorCache";
import type { AppContext, DecryptedBinding } from "./types";

const upstream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/endfieldClient/positionSocket", () => ({ getEndfieldPosition: upstream }));
const binding = {
  binding: { provider: "skland", role_id: "role", server_id: 1 },
  cred: "cred",
  token: "token",
} as DecryptedBinding;
const position = { pos: { x: 1, y: 2, z: 3 }, isOnline: true, mapId: "map", levelId: "level" };
const env = () => ({ DB: {}, ENDFIELD_CREDENTIAL_SECRET: "test-secret" }) as Bindings;
const context = (bindings: Bindings) => ({ env: bindings }) as AppContext;

describe("completed locator caches and request-owned refreshes", () => {
  beforeEach(() => upstream.mockReset().mockResolvedValue(position));

  it("deduplicates inside a request while independent requests can finish separately", async () => {
    const bindings = env();
    let release!: (data: typeof position) => void;
    upstream.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const firstContext = context(bindings);
    const first = refreshPositionCache(firstContext, "user:role", binding);
    const duplicate = refreshPositionCache(firstContext, "user:role", binding);
    await expect(
      refreshPositionCache(context(bindings), "user:role", binding),
    ).resolves.toMatchObject({ data: position });
    expect(upstream).toHaveBeenCalledTimes(2);
    release(position);
    const entries = await Promise.all([first, duplicate]);
    expect(entries[0]).toBe(entries[1]);
  });

  it("does not refill an invalidated cache from an older request", async () => {
    const bindings = env();
    let release!: (data: typeof position) => void;
    upstream.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = refreshPositionCache(context(bindings), "user:role", binding);
    deleteLocatorCaches(bindings, "user");
    release(position);
    await first;
    expect(readPositionCache(bindings, "user:role")).toBeUndefined();
  });

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
