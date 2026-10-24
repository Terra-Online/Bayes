import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteLocatorCaches, readPositionCache } from "@/services/locator/cache";
import type { DecryptedBinding } from "@/services/official/auth/types";
import type { Bindings } from "@/types/app";

import { createPositionRefreshScope, refreshPositionCache } from "./positionCache";

const upstream = vi.hoisted(() => vi.fn());
vi.mock("@/services/official/client/positionSocket", () => ({ getEndfieldPosition: upstream }));
const binding = {
  binding: { provider: "skland", role_id: "role", server_id: 1 },
  cred: "cred",
  token: "token",
} as DecryptedBinding;
const position = { pos: { x: 1, y: 2, z: 3 }, isOnline: true, mapId: "map", levelId: "level" };
const env = () => ({ DB: {}, ENDFIELD_CREDENTIAL_SECRET: "test-secret" }) as Bindings;

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
    const firstScope = createPositionRefreshScope(bindings);
    const first = refreshPositionCache(firstScope, "user:role", binding);
    const duplicate = refreshPositionCache(firstScope, "user:role", binding);
    await expect(
      refreshPositionCache(createPositionRefreshScope(bindings), "user:role", binding),
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
    const first = refreshPositionCache(createPositionRefreshScope(bindings), "user:role", binding);
    deleteLocatorCaches(bindings, "user");
    release(position);
    await first;
    expect(readPositionCache(bindings, "user:role")).toBeUndefined();
  });
});
