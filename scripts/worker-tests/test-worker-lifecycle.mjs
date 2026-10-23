import { test } from "node:test";

import { testLocator } from "./worker-lifecycle-locator.mjs";
import { testPersistence } from "./worker-lifecycle-persistence.mjs";
import { testPublicReads } from "./worker-lifecycle-public-reads.mjs";
import { createLifecycleRuntime } from "./worker-lifecycle-runtime.mjs";

// Separate runtimes keep provider modes, sockets and stored state within their domain.
for (const [name, scenarios] of [
  ["locator", testLocator],
  ["public reads", testPublicReads],
  ["persistence", testPersistence],
]) {
  await test(`native Workers: ${name}`, async (t) => {
    const runtime = await createLifecycleRuntime(t);
    await scenarios(t, runtime);
  });
}
