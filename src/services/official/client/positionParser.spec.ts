import { expect, it } from "vitest";

import { parseEndfieldPositionSocketMessage } from "./positionParser";

it("reads a binary provider envelope containing a serialized position payload", () => {
  const frame = new TextEncoder().encode(
    JSON.stringify({
      type: "1012",
      data: {
        code: 0,
        data: JSON.stringify({
          position: {
            pos: { x: "12.5", z: "-4" },
            levelId: "outpost",
            isOnline: true,
            mapId: "map01",
          },
        }),
      },
    }),
  ).buffer;
  expect(parseEndfieldPositionSocketMessage(frame)).toEqual({
    pos: { x: 12.5, y: 0, z: -4 },
    levelId: "outpost",
    isOnline: true,
    mapId: "map01",
  });
});
