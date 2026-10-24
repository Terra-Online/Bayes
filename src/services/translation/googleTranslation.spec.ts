import { afterEach, expect, it, vi } from "vitest";

import { translateText } from "./googleTranslation";

afterEach(() => vi.restoreAllMocks());

it("returns an empty batch without credentials or contacting Google", async () => {
  const fetchGoogle = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected Google request"));

  await expect(
    translateText(
      {
        location: "global",
        glossaryVersion: "g0",
        glossaryLanguages: new Set<string>(),
        allowedLanguages: new Set<string>(),
      },
      {
        contents: [],
        sourceLanguage: "auto",
        targetLanguage: "en-US",
      },
    ),
  ).resolves.toEqual([]);
  expect(fetchGoogle).not.toHaveBeenCalled();
});
