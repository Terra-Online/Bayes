import { describe, expect, it, vi } from "vitest";

vi.mock("./blacklist.json", () => ({ default: [" Disposable.EXAMPLE.TEST. "] }));

import { isDisposableEmail, isDisposableEmailDomain } from "./disposable";

describe("disposable email policy", () => {
  it("blocks a denylisted domain and its subdomains after domain normalization", () => {
    expect(isDisposableEmailDomain(" DISPOSABLE.EXAMPLE.TEST. ")).toBe(true);
    expect(isDisposableEmail("user@sub.disposable.example.test")).toBe(true);
  });

  it("allows self-hosted domains without heuristic disposable-name matching", () => {
    expect(isDisposableEmail("user@temporary-mail.example.test")).toBe(false);
    expect(isDisposableEmailDomain("disposable.example.test.allowed.test")).toBe(false);
  });
});
