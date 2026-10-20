import { describe, expect, it } from "vitest";

import type { Bindings } from "../types/app";
import { getRuntimeConfig, getSessionTtlSeconds, getUgcReadConfig } from "./config";

describe("read-path configuration", () => {
  it.each([
    {},
    { BETTER_AUTH_URL: "http://localhost:8787", SESSION_TTL_SECONDS: "900" },
    {
      UGC_ASSET_BASE_URL: "https://assets.example/",
      UGC_UPLOAD_TEST_PREFIX: "/test///data/",
      SESSION_TTL_SECONDS: "invalid",
    },
  ])("preserves full configuration semantics for %j", (values) => {
    const env = values as Bindings;
    const full = getRuntimeConfig(env);
    expect(getUgcReadConfig(env)).toEqual({
      ugcAssetBaseUrl: full.ugcAssetBaseUrl,
      ugcUploadPathPrefix: full.ugcUploadPathPrefix,
    });
    expect(getSessionTtlSeconds(env)).toBe(full.sessionTtlSeconds);
  });

  it("does not parse translation credentials or language/upload sets for reads", () => {
    const env = new Proxy({} as Bindings, {
      get(_target, key) {
        if (String(key).startsWith("GOOGLE_TRANSLATE") || key === "ALLOWED_UPLOAD_MIME") {
          throw new Error("Unrelated configuration read");
        }
        return undefined;
      },
    });
    expect(() => getUgcReadConfig(env)).not.toThrow();
    expect(() => getSessionTtlSeconds(env)).not.toThrow();
  });
});
