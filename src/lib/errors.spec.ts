import { describe, expect, it } from "vitest";

import { toSerializableError } from "./errors";

describe("runtime error diagnostics", () => {
  it("preserves flags and nested causes through JSON serialization", () => {
    const cause = Object.assign(new Error("reset"), { durableObjectReset: true, retryable: true });
    const error = Object.assign(new Error("busy", { cause }), { overloaded: true });
    expect(JSON.parse(JSON.stringify(toSerializableError(error)))).toMatchObject({
      name: "Error",
      message: "busy",
      overloaded: true,
      cause: { name: "Error", message: "reset", durableObjectReset: true, retryable: true },
    });
  });
  it("bounds cyclic error chains", () => {
    const error = new Error("cycle");
    error.cause = error;
    expect(toSerializableError(error)).toMatchObject({ cause: "[cause omitted]" });
  });
});
