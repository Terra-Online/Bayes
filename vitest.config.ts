import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Opt-in contract suite requires a separately installed Cor checkout.
    exclude: [...configDefaults.exclude, "scripts/cor-client-contract.spec.ts"],
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
        "src/services/official/client/types.ts",
        "src/repositories/binding/types.ts",
        "src/routes/auth/types.ts",
        "src/services/official/auth/types.ts",
        "src/services/official/locator/types.ts",
        "src/services/official/types.ts",
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
