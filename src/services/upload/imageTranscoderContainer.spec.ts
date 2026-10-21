import { afterEach, describe, expect, it, vi } from "vitest";

import { oem_imgTrans } from "./imageTranscoderContainer";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  exports: {},
}));

describe("container SDK lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("keeps a concurrent body alive and expires only after five idle seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IdentityTransformStream", TransformStream);
    let finish!: () => void;
    const pendingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new Uint8Array([2]));
          controller.close();
        };
      },
    });
    const responses = [new Response(new Uint8Array([1])), new Response(pendingBody)];
    for (const response of responses) {
      Object.defineProperty(response, "webSocket", { value: null });
    }
    const destroy = vi.fn();
    // Run the real SDK proxy and inflight accounting with stubbed runtime transport.
    const instance = Object.assign(Object.create(oem_imgTrans.prototype), {
      defaultPort: 8080,
      sleepAfter: "5s",
      sleepAfterMs: 0,
      inflightRequests: 0,
      state: { getState: async () => ({ status: "healthy" }) },
      container: {
        running: true,
        destroy,
        getTcpPort: () => ({ fetch: vi.fn(async () => responses.shift()!) }),
      },
    }) as {
      fetch(request: Request): Promise<Response>;
      isActivityExpired(): boolean;
      inflightRequests: number;
    };
    const [first, second] = await Promise.all([
      instance.fetch(new Request("http://container/prepare")),
      instance.fetch(new Request("http://container/prepare")),
    ]);
    expect(await first.arrayBuffer()).toEqual(new Uint8Array([1]).buffer);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(instance.inflightRequests).toBe(1);
    expect(instance.isActivityExpired()).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    finish();
    expect(await second.arrayBuffer()).toEqual(new Uint8Array([2]).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.inflightRequests).toBe(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(instance.isActivityExpired()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.isActivityExpired()).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });
});
