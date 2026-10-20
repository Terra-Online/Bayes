import { describe, expect, it } from "vitest";
import { encodeBase64, decodeBase64 } from "./bitmap";

describe("progress base64 compatibility", () => {
  it("preserves bytes, empty values and views without exposing the backing buffer", () => {
    for (const size of [0, 1, 2, 3, 255, 4096, 12500]) {
      const backing = Uint8Array.from({ length: size + 6 }, (_, index) => index % 256);
      const bytes = backing.subarray(3, 3 + size);
      const reference = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
      expect(encodeBase64(bytes)).toBe(reference);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });
});
