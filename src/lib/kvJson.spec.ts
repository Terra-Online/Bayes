import { describe, expect, it, vi } from "vitest";
import { getJsonFromKv } from "./kvJson";

describe("getJsonFromKv", () => {
  it("does not make a new invocation wait for an unfinished read from another invocation", async () => {
    let finishFirst!: (value: string) => void;
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(JSON.stringify({ owner: "second" }));
    const kv = { get } as unknown as KVNamespace;
    const first = getJsonFromKv(kv, "shared-key");
    const second = getJsonFromKv(kv, "shared-key");
    try {
      expect(get).toHaveBeenCalledTimes(2);
      await expect(second).resolves.toEqual({ owner: "second" });
    } finally {
      finishFirst(JSON.stringify({ owner: "first" }));
      await Promise.all([first, second]);
    }
  });

  it("treats a KV read failure as a cache miss", async () => {
    const kv = {
      get: vi.fn().mockRejectedValue(new Error("KV GET failed"))
    } as unknown as KVNamespace;

    await expect(getJsonFromKv(kv, "cache-key")).resolves.toBeNull();
  });
});
