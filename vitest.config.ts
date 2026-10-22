import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.spec.ts",
        "src/**/*.test.ts",
        "src/test/**",
        "src/**/*.d.ts",
        "src/types/**",
        // These modules contain only types. submission/types.ts also exports a
        // runtime value, so a blanket **/types.ts exclusion would hide code.
        "src/lib/endfieldClient/types.ts",
        "src/repositories/binding/types.ts",
        "src/routes/auth/types.ts",
        "src/services/binding/types.ts",
        "src/services/locator/types.ts",
        "src/services/sync/types.ts",
        "src/services/moderation/messages.ts",
      ],
      reporter: ["text", "html", "json-summary"],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
