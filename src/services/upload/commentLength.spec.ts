import { describe, expect, it } from "vitest";

import { getCommentLength } from "./commentLength";

describe("comment source length", () => {
  it.each([
    ["English中文😀", 11],
    [":sns_001::sns_038:", 4],
    [":sns_000::sns_039:", 18],
    ["**:sns_001:**", 6],
    ["||__~~:sns_038:~~__||", 14],
    ["\\:sns_001:", 10],
    ["\\\\:sns_001:", 4],
    ["`:sns_001:`", 11],
    ["`unclosed :sns_001:", 12],
    ["[:sns_001:](https://example.com)", 25],
    ["[link](https://example.com/:sns_001:)", 37],
    ["[link](javascript::sns_001:)", 21],
    ["\n:sns_001:\n", 4],
  ])("counts %j using the editor source rules", (source, length) => {
    expect(getCommentLength(source)).toBe(length);
  });

  it("uses the first closing link delimiter like the editor for nested labels", () => {
    let source = ":sns_001:";
    for (let index = 0; index < 17; index += 1) {
      source = `[${source}](https://example.com)`;
    }
    expect(getCommentLength(source)).toBe(source.length - 7);
  });
});
