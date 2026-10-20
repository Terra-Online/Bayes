import { getRandom } from "@cloudflare/containers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onAppError } from "../../middleware/error-handler";
import { createPendingSubmission } from "../../repositories/submission/createSubmission";
import type { AppEnv, AuthUser, Bindings } from "../../types/app";
import { enqueueModeration } from "../moderation/queue";
import type { oem_imgTrans } from "./imageTranscoderContainer";
import { handleSubmitImage } from "./submitImage";

vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("../../repositories/submission/createSubmission", () => ({
  createPendingSubmission: vi.fn(),
}));
vi.mock("../moderation/queue", () => ({ enqueueModeration: vi.fn() }));
vi.mock("../../repositories/submission-duplicates", () => ({
  getDuplicateImageMarkerSummary: async () => null,
}));

describe("upload side effects after preparation", () => {
  const fetch = vi.fn();
  const put = vi.fn();
  let app: Hono<AppEnv>;
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.clearAllMocks();
    fetch.mockReset();
    vi.mocked(getRandom).mockResolvedValue({ fetch } as unknown as DurableObjectStub<oem_imgTrans>);
    app = new Hono<AppEnv>();
    app.onError(onAppError);
    app.use("*", async (c, next) => {
      c.set("authUser", { uid: "u" } as AuthUser);
      await next();
    });
    app.post("/image", handleSubmitImage);
  });
  afterEach(() => vi.restoreAllMocks());
  function request(signal?: AbortSignal) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "test.png", { type: "image/png" }));
    form.set("markerId", "42");
    form.set("poiHash", "hash");
    form.set("poiType", "poi");
    return app.request(
      new Request("https://api.opendfieldmap.org/image", { method: "POST", body: form, signal }),
      undefined,
      {
        OEM_IMG_TRANS: {},
        UGC_BUCKET: { put },
        DB: {},
      } as unknown as Bindings,
    );
  }
  function expectNoWrites() {
    expect(put).not.toHaveBeenCalled();
    expect(createPendingSubmission).not.toHaveBeenCalled();
    expect(enqueueModeration).not.toHaveBeenCalled();
  }
  it("writes and enqueues exactly once after a successful retry", async () => {
    fetch.mockRejectedValueOnce(new Error("The container just disconnected"));
    fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([4, 5]), { headers: { "content-type": "image/webp" } }),
    );
    expect((await request()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(createPendingSubmission).toHaveBeenCalledTimes(1);
    expect(enqueueModeration).toHaveBeenCalledTimes(1);
  });
  it.each([
    [422, 422, "IMAGE_PROCESSING_FAILED"],
    [429, 503, "DEPENDENCY_OVERLOADED"],
    [500, 503, "DEPENDENCY_UNAVAILABLE"],
  ])("leaves no business writes after HTTP %s", async (upstreamStatus, status, code) => {
    fetch.mockResolvedValue(
      new Response("private container diagnostic", { status: upstreamStatus }),
    );
    const response = await request();
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe(status === 503 ? "5" : null);
    expect(await response.json()).toMatchObject({ code });
    expectNoWrites();
  });
  it("leaves no writes after cancellation during preparation", async () => {
    const controller = new AbortController();
    fetch.mockImplementation(async () => {
      controller.abort();
      return new Response(new Uint8Array([4]), { headers: { "content-type": "image/png" } });
    });
    await request(controller.signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });
});
