import { describe, expect, it, vi } from "vitest";

import logger, { getErrorReasons, isErrorTrace } from "./index";

function makeTrace(overrides: Partial<TraceItem> = {}): TraceItem {
  return {
    event: {
      request: {
        cf: {},
        headers: {},
        method: "GET",
        url: "https://api.example.test/resource",
        getUnredacted() {
          return this;
        },
      },
      response: { status: 200 },
    },
    eventTimestamp: 1_700_000_000_000,
    logs: [],
    exceptions: [],
    diagnosticsChannelEvents: [],
    scriptName: "producer",
    outcome: "ok",
    executionModel: "stateless",
    truncated: false,
    cpuTime: 1,
    wallTime: 2,
    ...overrides,
  };
}

describe("isErrorTrace", () => {
  const longLivedLocatorTrace = (overrides: Partial<TraceItem> = {}) =>
    makeTrace({
      scriptName: "oem-backend",
      outcome: "exception",
      wallTime: 3_446_500,
      exceptions: [{ name: "Error", message: "Network connection lost.", timestamp: 1 }],
      event: {
        request: {
          cf: {},
          headers: { upgrade: "websocket" },
          method: "GET",
          url: "https://api.opendfieldmap.org/locator/position-stream?ticket=redacted",
          getUnredacted() {
            return this;
          },
        },
      },
      ...overrides,
    });

  it("ignores an isolated network disconnect on a long-lived locator socket", () => {
    expect(isErrorTrace(longLivedLocatorTrace())).toBe(false);
  });

  it("does not write a long-lived locator disconnect to D1", () => {
    const prepare = vi.fn();
    const waitUntil = vi.fn();
    logger.tail(
      [longLivedLocatorTrace()],
      {
        OEM_ERR: { prepare } as unknown as D1Database,
      },
      { waitUntil } as unknown as ExecutionContext,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("retains short-lived disconnects and unrelated failures", () => {
    expect(isErrorTrace(longLivedLocatorTrace({ wallTime: 1000 }))).toBe(true);
    expect(isErrorTrace(longLivedLocatorTrace({ scriptName: "other-worker" }))).toBe(true);
    expect(
      isErrorTrace(
        longLivedLocatorTrace({
          event: {
            request: {
              cf: {},
              headers: {},
              method: "GET",
              url: "https://api.opendfieldmap.org/locator/position-stream",
              getUnredacted() {
                return this;
              },
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isErrorTrace(
        longLivedLocatorTrace({ exceptions: [{ name: "Error", message: "failed", timestamp: 1 }] }),
      ),
    ).toBe(true);
    expect(
      isErrorTrace(
        longLivedLocatorTrace({ logs: [{ level: "error", message: ["failed"], timestamp: 1 }] }),
      ),
    ).toBe(true);
    expect(isErrorTrace(longLivedLocatorTrace({ outcome: "loadShed" }))).toBe(true);
    expect(
      isErrorTrace(
        longLivedLocatorTrace({
          event: {
            request: {
              cf: {},
              headers: { upgrade: "websocket" },
              method: "GET",
              url: "https://api.opendfieldmap.org/other",
              getUnredacted() {
                return this;
              },
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isErrorTrace(
        longLivedLocatorTrace({
          event: {
            request: {
              cf: {},
              headers: { upgrade: "websocket" },
              method: "GET",
              url: "https://api.opendfieldmap.org/locator/position-stream",
              getUnredacted() {
                return this;
              },
            },
            response: { status: 502 },
          },
        }),
      ),
    ).toBe(true);
  });

  it("drops pure cancellations and their routine network exceptions", () => {
    expect(isErrorTrace(makeTrace({ outcome: "canceled" }))).toBe(false);
    expect(
      isErrorTrace(
        makeTrace({
          outcome: "canceled",
          exceptions: [{ name: "Error", message: "Network connection lost.", timestamp: 1 }],
        }),
      ),
    ).toBe(false);
  });

  it("retains server errors that precede cancellation", () => {
    expect(
      getErrorReasons(
        makeTrace({
          outcome: "canceled",
          event: {
            request: {
              cf: {},
              headers: {},
              method: "GET",
              url: "https://api.example.test/resource",
              getUnredacted() {
                return this;
              },
            },
            response: { status: 503 },
          },
        }),
      ),
    ).toEqual(["http_5xx"]);
    expect(
      getErrorReasons(
        makeTrace({
          outcome: "canceled",
          logs: [{ level: "error", message: ["db failed"], timestamp: 1 }],
        }),
      ),
    ).toEqual(["console_error"]);
    expect(
      getErrorReasons(
        makeTrace({
          outcome: "canceled",
          exceptions: [{ name: "Error", message: "db failed", timestamp: 1 }],
        }),
      ),
    ).toEqual(["runtime_exception"]);
  });

  it("does not issue any D1 writes for a canceled-only tail batch", () => {
    const prepare = vi.fn();
    const waitUntil = vi.fn();
    logger.tail(
      [makeTrace({ outcome: "canceled" })],
      {
        OEM_ERR: { prepare } as unknown as D1Database,
      },
      { waitUntil } as unknown as ExecutionContext,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each(["loadShed", "responseStreamDisconnected", "exception"] as const)(
    "keeps non-canceled outcome %s",
    (outcome) => {
      expect(isErrorTrace(makeTrace({ outcome }))).toBe(true);
    },
  );

  it("captures a handled HTTP 502 response", () => {
    const trace = makeTrace({
      event: {
        request: {
          cf: {},
          headers: {},
          method: "GET",
          url: "https://api.example.test/resource",
          getUnredacted() {
            return this;
          },
        },
        response: { status: 502 },
      },
    });

    expect(isErrorTrace(trace)).toBe(true);
  });

  it("captures console.error and exceptions", () => {
    expect(
      isErrorTrace(
        makeTrace({
          logs: [{ level: "error", message: ["failed"], timestamp: 1 }],
        }),
      ),
    ).toBe(true);
    expect(
      isErrorTrace(
        makeTrace({
          exceptions: [{ name: "Error", message: "failed", timestamp: 1 }],
        }),
      ),
    ).toBe(true);
  });

  it("ignores successful and client-error responses", () => {
    expect(isErrorTrace(makeTrace())).toBe(false);
    expect(
      isErrorTrace(
        makeTrace({
          event: {
            request: {
              cf: {},
              headers: {},
              method: "GET",
              url: "https://api.example.test/resource",
              getUnredacted() {
                return this;
              },
            },
            response: { status: 404 },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("error persistence", () => {
  it("writes one classified row per failed invocation in a mixed batch", async () => {
    const bound: unknown[][] = [];
    const statement = {
      bind: vi.fn((...args: unknown[]) => {
        bound.push(args);
        return statement;
      }),
    };
    const prepare = vi.fn(() => statement);
    const batch = vi.fn().mockResolvedValue([]);
    const pending: Promise<unknown>[] = [];
    const failed = makeTrace({
      outcome: "exception",
      logs: [{ level: "error", message: ["failed"], timestamp: 1 }],
      exceptions: [{ name: "Error", message: "failed", timestamp: 1 }],
    });
    logger.tail(
      [makeTrace(), makeTrace({ outcome: "canceled" }), failed, makeTrace({ outcome: "loadShed" })],
      { OEM_ERR: { prepare, batch } as unknown as D1Database },
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      } as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenCalledWith([statement, statement]);
    expect(bound[0][16]).toBe(JSON.stringify(failed));
    expect(JSON.parse(bound[0][17] as string)).toEqual(["runtime_exception", "console_error"]);
    expect(JSON.parse(bound[1][17] as string)).toEqual(["outcome_failure"]);
  });

  it("does not serialize or persist successful invocations", () => {
    const prepare = vi.fn();
    const successful = makeTrace();
    const serialize = vi.fn(() => {
      throw new Error("unexpected serialization");
    });
    Object.assign(successful, { toJSON: serialize });
    logger.tail([successful], { OEM_ERR: { prepare } as unknown as D1Database }, {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);
    expect(prepare).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
  });
});
