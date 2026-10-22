import { getRandom } from "@cloudflare/containers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";

import { prepareUploadImageForStorage } from "./storage";

vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

describe("image preparation transport", () => {
  let mocks: MockBindings;
  let database: TestDatabase;
  function prepare(signal?: AbortSignal) {
    return prepareUploadImageForStorage({
      body: new Uint8Array([1, 2, 3]).buffer,
      mimeType: "image/png",
      transcoder: mocks.bindings.OEM_IMG_TRANS,
      requestId: "upload-request",
      signal,
    });
  }
  const image = () =>
    new Response(new Uint8Array([4, 5]), {
      headers: { "content-type": "image/webp", "x-converted-to-webp": "true" },
    });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    database = createTestDatabase();
    mocks = createMockBindings({ DB: database.db });
    vi.mocked(getRandom).mockReset();
    vi.mocked(getRandom).mockResolvedValue(mocks.imageTranscoder);
  });
  afterEach(() => {
    database.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    new Error("The container is not running, consider calling start()"),
    new Error("The container just disconnected, try calling start() again"),
    new Response("Container suddenly disconnected, try again", { status: 500 }),
  ])("retries only a clear container disconnect with a fresh request", async (first) => {
    if (first instanceof Error) {
      mocks.imageTranscoder.fetch.mockRejectedValueOnce(first);
    } else {
      mocks.imageTranscoder.fetch.mockResolvedValueOnce(first);
    }
    mocks.imageTranscoder.fetch.mockResolvedValueOnce(image());
    const work = prepare();
    await vi.advanceTimersByTimeAsync(249);
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await work).toMatchObject({ mimeType: "image/webp", sizeBytes: 2, converted: true });
    expect(getRandom).toHaveBeenCalledTimes(2);
    // These fields identify which external operation failed before the retry.
    expect(console.warn).toHaveBeenCalledWith(
      "image preparation failed",
      expect.objectContaining({
        requestId: "upload-request",
        attempt: 1,
        stage: first instanceof Error ? "container_fetch" : "container_response",
      }),
    );
    expect(getRandom).toHaveBeenNthCalledWith(1, mocks.bindings.OEM_IMG_TRANS, 3);
    const requests = mocks.imageTranscoder.fetch.mock.calls.map(([request]) => request as Request);
    expect(requests[0]).not.toBe(requests[1]);
    expect(await requests[0]!.arrayBuffer()).toEqual(await requests[1]!.arrayBuffer());
  });
  it("uses a single 60-second deadline for both attempts", async () => {
    mocks.imageTranscoder.fetch
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 59_500));
        throw new Error("The container just disconnected");
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    const assertion = expect(prepare()).rejects.toMatchObject({
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(59_750);
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect((mocks.imageTranscoder.fetch.mock.calls[1]![0] as Request).signal.aborted).toBe(true);
  });
  it("includes response body consumption in the deadline", async () => {
    mocks.imageTranscoder.fetch.mockResolvedValue(
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "image/png" },
      }),
    );
    const assertion = expect(prepare()).rejects.toMatchObject({
      status: 503,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledTimes(1);
  });
  it("propagates client cancellation without retries", async () => {
    const controller = new AbortController();
    mocks.imageTranscoder.fetch.mockImplementation(() => new Promise(() => {}));
    const assertion = expect(prepare(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    expect(mocks.imageTranscoder.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
