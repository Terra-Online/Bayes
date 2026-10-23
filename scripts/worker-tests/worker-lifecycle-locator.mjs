import assert from "node:assert/strict";

export async function testLocator(t, { read }) {
  await t.test("subscribed sockets release both intervals immediately on abort", async () => {
    assert.deepEqual(await read("socket"), { active: 2, timers: 0 });
  });
  await t.test("one-shot positions close the upstream socket and all deadlines", async () => {
    assert.deepEqual(await read("position"), {
      position: { pos: { x: 1, y: 2, z: 3 }, levelId: "level", isOnline: true, mapId: "map" },
      timers: 0,
    });
  });
}
