import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withRequestTelemetry } from "./requestTelemetry";

describe("HTTP request telemetry", () => {
  const log = vi.fn();
  beforeEach(() => {
    log.mockClear();
    vi.spyOn(console, "log").mockImplementation(log);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function request() {
    const value = new Request("https://api.example.test/resource?ticket=do-not-log", {
      method: "POST",
      headers: {
        "cf-ray": "example-NRT",
        "cf-connecting-ip": "192.0.2.1",
        "x-request-id": "incoming",
        cookie: "session=do-not-log",
        authorization: "Bearer do-not-log",
      },
      body: "private-body",
    });
    Object.defineProperty(value, "cf", {
      value: {
        country: "JP",
        region: "Tokyo",
        regionCode: "13",
        city: "Tokyo",
        colo: "NRT",
        asn: 64500,
        asOrganization: "Example Network",
      },
    });
    return value;
  }

  it.each([200, 404, 503])(
    "records metadata and response readiness for HTTP %i",
    async (status) => {
      const response = new Response("response-body", {
        status,
        headers: { "x-request-id": "generated" },
      });
      const result = await withRequestTelemetry(request(), "default", async () => {
        vi.setSystemTime(1_025);
        return response;
      });
      expect(result).toBe(response);
      expect(result.bodyUsed).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "oem.request",
          schemaVersion: 1,
          source: "edge",
          entrypoint: "default",
          startedAtMs: 1_000,
          responseReadyMs: 25,
          status,
          result: "response",
          path: "/resource",
          host: "api.example.test",
          method: "POST",
          protocol: "http",
          clientIp: "192.0.2.1",
          country: "JP",
          city: "Tokyo",
          region: "Tokyo",
          regionCode: "13",
          asn: 64500,
          asOrganization: "Example Network",
          colo: "NRT",
          rayId: "example-NRT",
          requestId: "generated",
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /do-not-log|private-body|response-body|authorization|cookie/,
      );
    },
  );

  it("records thrown handlers without changing the exception", async () => {
    const error = new Error("private exception");
    await expect(
      withRequestTelemetry(request(), "default", () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ status: null, result: "threw", requestId: "incoming" }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private exception");
  });

  it("preserves WebSocket responses and measures only handshake readiness", async () => {
    const socket = {};
    const response = {
      status: 101,
      headers: new Headers(),
      webSocket: socket,
    } as unknown as Response;
    const upgrade = new Request("https://api.example.test/notify/v1/live?ticket=private", {
      headers: { upgrade: "websocket" },
    });
    expect(await withRequestTelemetry(upgrade, "default", () => response)).toBe(response);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "websocket", status: 101, responseReadyMs: 0 }),
    );
  });

  it("does not count internal cache reads as client traffic", async () => {
    await withRequestTelemetry(request(), "PublicReadCache", () => new Response());
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "internal",
        entrypoint: "PublicReadCache",
        clientIp: null,
        country: null,
        region: null,
        city: null,
        asn: null,
        colo: "NRT",
      }),
    );
  });

  it("supports local and non-edge requests without geographic metadata", async () => {
    await withRequestTelemetry(
      new Request("https://example.test"),
      "default",
      () => new Response(),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ source: "unknown", country: null, colo: null, clientIp: null }),
    );
  });
});
