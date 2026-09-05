import { describe, expect, it, vi } from "vitest";
import { getJsonFromKv } from "./kvJson";

describe("getJsonFromKv", () => {
  it("treats a KV read failure as a cache miss", async () => {
    const kv = {
      get: vi.fn().mockRejectedValue(new Error("KV GET failed"))
    } as unknown as KVNamespace;

    await expect(getJsonFromKv(kv, "cache-key")).resolves.toBeNull();
  });
});
