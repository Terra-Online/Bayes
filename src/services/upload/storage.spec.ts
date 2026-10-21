import { getRandom } from "@cloudflare/containers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { oem_imgTrans } from "./imageTranscoderContainer";
import { prepareUploadImageForStorage } from "./storage";

vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

describe("image preparation transport", () => {
  const fetch = vi.fn();
  const payload = {
    body: new Uint8Array([1, 2, 3]).buffer,
    mimeType: "image/png",
    transcoder: {} as DurableObjectNamespace<oem_imgTrans>,
    requestId: "upload-request",
  };
  const image = () =>
    new Response(new Uint8Array([4, 5]), {
      headers: { "content-type": "image/webp", "x-converted-to-webp": "true" },
    });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetch.mockReset();
    vi.mocked(getRandom).mockReset();
    vi.mocked(getRandom).mockResolvedValue({ fetch } as unknown as DurableObjectStub<oem_imgTrans>);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["image/webp", "image/avif"])(
    "passes through %s without a container",
    async (mimeType) => {
      expect(await prepareUploadImageForStorage({ ...payload, mimeType })).toMatchObject({
        body: payload.body,
        converted: false,
      });
      expect(getRandom).not.toHaveBeenCalled();
    },
  );
  it.each([
    [400, "IMAGE_PROCESSING_FAILED", 422],
    [413, "IMAGE_PROCESSING_FAILED", 422],
    [415, "IMAGE_PROCESSING_FAILED", 422],
    [422, "IMAGE_PROCESSING_FAILED", 422],
    [429, "DEPENDENCY_OVERLOADED", 503],
    [500, "DEPENDENCY_UNAVAILABLE", 503],
    [503, "DEPENDENCY_UNAVAILABLE", 503],
  ])("classifies HTTP %s without replay", async (status, code, expectedStatus) => {
    fetch.mockResolvedValue(new Response("internal diagnostic", { status }));
    await expect(prepareUploadImageForStorage(payload)).rejects.toMatchObject({
      status: expectedStatus,
      code,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      "image preparation failed",
      expect.objectContaining({
        attempt: 1,
        stage: "container_response",
        requestId: "upload-request",
      }),
    );
  });
  it.each([
    new Error("The container is not running, consider calling start()"),
    new Error("The container just disconnected, try calling start() again"),
    new Response("Container suddenly disconnected, try again", { status: 500 }),
  ])("retries only a clear container disconnect with a fresh request", async (first) => {
    if (first instanceof Error) {
      fetch.mockRejectedValueOnce(first);
    } else {
      fetch.mockResolvedValueOnce(first);
    }
    fetch.mockResolvedValueOnce(image());
    const work = prepareUploadImageForStorage(payload);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await work).toMatchObject({ mimeType: "image/webp", sizeBytes: 2, converted: true });
    expect(getRandom).toHaveBeenCalledTimes(2);
    expect(getRandom).toHaveBeenNthCalledWith(1, payload.transcoder, 3);
    const requests = fetch.mock.calls.map(([request]) => request as Request);
    expect(requests[0]).not.toBe(requests[1]);
    expect(await requests[0]!.arrayBuffer()).toEqual(await requests[1]!.arrayBuffer());
  });
  it("limits disconnect retries to two attempts", async () => {
    fetch.mockRejectedValue(new Error("The container just disconnected"));
    const assertion = expect(prepareUploadImageForStorage(payload)).rejects.toMatchObject({
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("never retries a flagged overload even if its message mentions disconnect", async () => {
    fetch.mockRejectedValue(
      Object.assign(new Error("The container just disconnected"), { overloaded: true }),
    );
    await expect(prepareUploadImageForStorage(payload)).rejects.toMatchObject({
      code: "DEPENDENCY_OVERLOADED",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("classifies an explicit container capacity limit as overload", async () => {
    fetch.mockResolvedValue(new Response("Container capacity exhausted", { status: 503 }));
    await expect(prepareUploadImageForStorage(payload)).rejects.toMatchObject({
      code: "DEPENDENCY_OVERLOADED",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["text/html", "", "image/not-real"])(
    "rejects malformed success MIME %j",
    async (mimeType) => {
      fetch.mockResolvedValue(new Response("body", { headers: { "content-type": mimeType } }));
      await expect(prepareUploadImageForStorage(payload)).rejects.toMatchObject({
        status: 502,
        code: "IMAGE_PROCESSING_BAD_RESPONSE",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects empty successful images", async () => {
    fetch.mockResolvedValue(new Response(null, { headers: { "content-type": "image/png" } }));
    await expect(prepareUploadImageForStorage(payload)).rejects.toMatchObject({ status: 502 });
  });
  it("uses a single 60-second deadline for both attempts", async () => {
    fetch
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 59_500));
        throw new Error("The container just disconnected");
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    const assertion = expect(prepareUploadImageForStorage(payload)).rejects.toMatchObject({
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(59_750);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect((fetch.mock.calls[1]![0] as Request).signal.aborted).toBe(true);
  });
  it("includes response body consumption in the deadline", async () => {
    fetch.mockResolvedValue(
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "image/png" },
      }),
    );
    const assertion = expect(prepareUploadImageForStorage(payload)).rejects.toMatchObject({
      status: 503,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("propagates client cancellation without retries", async () => {
    const controller = new AbortController();
    fetch.mockImplementation(() => new Promise(() => {}));
    const assertion = expect(
      prepareUploadImageForStorage({ ...payload, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
