import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DecryptedBinding } from "@/services/binding/types";
import { deleteLocatorCaches, readPositionCache } from "@/services/locator/cache";
import type { AppEnv, Bindings } from "@/types/app";

import { refreshPositionCache } from "./positionCache";

const upstream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/endfieldClient/positionSocket", () => ({ getEndfieldPosition: upstream }));
const binding = {
  binding: { provider: "skland", role_id: "role", server_id: 1 },
  cred: "cred",
  token: "token",
} as DecryptedBinding;
const position = { pos: { x: 1, y: 2, z: 3 }, isOnline: true, mapId: "map", levelId: "level" };
const env = () => ({ DB: {}, ENDFIELD_CREDENTIAL_SECRET: "test-secret" }) as Bindings;
const context = (bindings: Bindings) => ({ env: bindings }) as Context<AppEnv>;

describe("request-owned position refreshes", () => {
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
});
