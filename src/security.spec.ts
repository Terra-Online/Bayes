import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "./types/app";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {}, DurableObject: class {}, exports: {} }));
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getContainer: vi.fn() }));
import { createApp } from "./app";
import { sendModerationNotificationNow } from "./services/moderation/notifications";
import { OEMUserDO } from "./services/progress/userDo";
import type { ProgressDoEnv } from "./services/progress/manifest";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("backend safety boundaries", () => {
  it.each([
    ["https://api.opendfieldmap.org", "https://api.opendfieldmap.org"],
    ["http://localhost:8787", "https://api.opendfieldmap.org"],
    ["https://api.opendfieldmap.org", "http://localhost:8787"]
  ])("rejects the demo R2 writer with request %s and backend %s", async (requestOrigin, backendOrigin) => {
    const put = vi.fn();
    const response = await createApp().request(`${requestOrigin}/__demo/r2?key=existing.webp`, {
      method: "PUT", headers: { "x-demo-local-sync": "1" }, body: "untrusted"
    }, { BETTER_AUTH_URL: backendOrigin, UGC_BUCKET: { put } } as unknown as Bindings);
    expect(response.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it("retains the explicitly local demo upload", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const response = await createApp().request("http://localhost:8787/__demo/r2?key=demo.webp", {
      method: "PUT", headers: { "x-demo-local-sync": "1" }, body: "local-demo"
    }, { BETTER_AUTH_URL: "http://localhost:8787", UGC_BUCKET: { put } } as unknown as Bindings);
    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("never sends moderation data to a built-in webhook", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendModerationNotificationNow({} as Bindings, {
      type: "comment_translation_prewarm_completed",
      source: "auto_moderation",
      submission: {} as never,
      targets: []
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a normal progress conflict without error-level telemetry", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const object = new OEMUserDO({ id: { name: "user-1" } } as unknown as DurableObjectState, {
      OEM_KV: { get: async () => null },
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) }
    } as unknown as ProgressDoEnv);
    const response = await object.fetch(new Request("https://progress-user/sync", {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": "trace-1" },
      body: JSON.stringify({
        baseRevision: "", clientMutationId: "mutation-1", markerIndexHash: "a".repeat(64),
        setPointIds: [], clearPointIds: [], updatedAt: Date.now()
      })
    }));
    expect(response.status).toBe(409);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).toHaveBeenCalledWith("[progress][sync] request rejected", expect.objectContaining({
      status: 409, code: "PROGRESS_MANIFEST_NOT_REGISTERED", requestId: "trace-1", clientMutationId: "mutation-1"
    }));
  });
});
