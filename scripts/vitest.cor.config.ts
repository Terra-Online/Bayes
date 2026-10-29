import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/cor-client-contract.spec.ts"] },
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
});
