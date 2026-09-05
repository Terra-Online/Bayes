import { describe, expect, it, vi } from "vitest";
import logger, { isErrorTrace } from "./index";

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
        }
      },
      response: { status: 200 }
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
    ...overrides
  };
}

describe("isErrorTrace", () => {
  it("drops canceled outcomes even when they contain logs or exceptions", () => {
    expect(isErrorTrace(makeTrace({ outcome: "canceled" }))).toBe(false);
    expect(isErrorTrace(makeTrace({
      outcome: "canceled",
      logs: [{ level: "error", message: ["request canceled"], timestamp: 1 }],
      exceptions: [{ name: "Error", message: "Network connection lost.", timestamp: 1 }]
    }))).toBe(false);
  });

  it("does not issue any D1 writes for a canceled-only tail batch", () => {
    const prepare = vi.fn();
    const waitUntil = vi.fn();
    logger.tail([makeTrace({ outcome: "canceled" })], {
      OEM_ERR: { prepare } as unknown as D1Database
    }, { waitUntil } as unknown as ExecutionContext);
    expect(prepare).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each(["loadShed", "responseStreamDisconnected", "exception"] as const)("keeps non-canceled outcome %s", (outcome) => {
    expect(isErrorTrace(makeTrace({ outcome }))).toBe(true);
  });

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
          }
        },
        response: { status: 502 }
      }
    });

    expect(isErrorTrace(trace)).toBe(true);
  });

  it("captures console.error and exceptions", () => {
    expect(isErrorTrace(makeTrace({
      logs: [{ level: "error", message: ["failed"], timestamp: 1 }]
    }))).toBe(true);
    expect(isErrorTrace(makeTrace({
      exceptions: [{ name: "Error", message: "failed", timestamp: 1 }]
    }))).toBe(true);
  });

  it("ignores successful and client-error responses", () => {
    expect(isErrorTrace(makeTrace())).toBe(false);
    expect(isErrorTrace(makeTrace({
      event: {
        request: {
          cf: {},
          headers: {},
          method: "GET",
          url: "https://api.example.test/resource",
          getUnredacted() {
            return this;
          }
        },
        response: { status: 404 }
      }
    }))).toBe(false);
  });
});
