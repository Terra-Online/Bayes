import assert from "node:assert/strict";

import { deferred, within } from "./worker-test-runtime.mjs";

export async function testPublicReads(t, { read, gate }) {
  for (const kind of ["images", "comments"]) {
    await t.test(`${kind}: independent cold reads and completed KV reuse`, async () => {
      const first = read(`${kind}-cold`, { "x-test-kind": kind, "x-test-block": "1" });
      await within(gate.blocked.promise);
      try {
        assert.deepEqual(await read(`${kind}-cold`, { "x-test-kind": kind }), {
          items: [],
          statements: 1,
        });
      } finally {
        gate.released.resolve();
      }
      assert.deepEqual(await first, { items: [], statements: 1 });
      assert.deepEqual(await read(`${kind}-cold`, { "x-test-kind": kind }), {
        items: [],
        statements: 0,
      });
      gate.blocked = deferred();
      gate.released = deferred();
    });
  }
}
