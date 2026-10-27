import { getCookies } from "better-auth/cookies";
import { describe, expect, it } from "vitest";

import type { Bindings } from "@/types/app";

import { authCookieOptions } from "./origins";
import { hasSessionCredentials } from "./sessionCredentials";

describe("session credential presence", () => {
  it.each([undefined, "https://api.opendfieldmap.org", "http://localhost:8787"])(
    "matches current and legacy Better Auth cookies for %s",
    (url) => {
      const env = { BETTER_AUTH_URL: url } as Bindings;
      const options = authCookieOptions(env);
      const current = getCookies(options).sessionToken.name;
      const legacy = getCookies({
        ...options,
        advanced: { ...options.advanced, cookiePrefix: "better-auth" },
      }).sessionToken.name;
      for (const name of [current, legacy]) {
        expect(
          hasSessionCredentials(env, {
            cookie: `analytics=abc;${name}=token.signature; other=123`,
          }),
        ).toBe(true);
        // Malformed and expired credentials must reach the auth library for verification.
        expect(hasSessionCredentials(env, { cookie: `${name}=invalid` })).toBe(true);
      }
      expect(
        hasSessionCredentials(env, { cookie: "analytics=abc; cf_clearance=xyz; session=test" }),
      ).toBe(false);
      expect(hasSessionCredentials(env, {})).toBe(false);
      expect(hasSessionCredentials(env, { cookie: `other=${current}=value` })).toBe(false);
    },
  );

  it.each(["Bearer opaque", "Bearer malformed.signature", "Basic invalid"])(
    "passes authorization through unchanged: %s",
    (authorization) => {
      expect(hasSessionCredentials({} as Bindings, { authorization })).toBe(true);
    },
  );
});
