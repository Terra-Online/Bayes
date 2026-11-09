import { vi } from "vitest";

// Node requires duplex for request streams. Workers accepts them without it.
export function stubRequestWithDuplex(): void {
  const NativeRequest = Request;
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, duplex: "half" } as RequestInit);
      }
    },
  );
}
