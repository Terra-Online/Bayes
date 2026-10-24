import { describe, expect, it } from "vitest";

import { commentContentSchema, getCommentLength } from "./commentContent";

describe("comment content contract", () => {
  it("counts text and Unicode using the editor's UTF-16 units", () => {
    for (const content of ["中".repeat(500), "😀".repeat(250)]) {
      expect(commentContentSchema.parse(content)).toBe(content);
      expect(commentContentSchema.safeParse(content + "a").success).toBe(false);
    }
  });

  it("allows 250 rendered emojis even though their source exceeds 500 characters", () => {
    const content = ":sns_001:".repeat(250);
    expect(commentContentSchema.parse(content)).toBe(content);
    expect(commentContentSchema.safeParse(content + ":sns_038:").success).toBe(false);
  });

  it("applies editor source lengths to formatting, code, links and escaped or unknown emojis", () => {
    // Formatting and link syntax retain overhead; only rendered emoji tokens cost two units.
    for (const [suffix, length] of [
      [":sns_038:", 2],
      ["**:sns_001:**", 6],
      ["`:sns_001:`", 11],
      ["\\:sns_001:", 10],
      ["[:sns_001:](https://example.com)", 25],
      ["[label](https://example.com/:sns_001:)", 38],
      [":sns_000:", 9],
      [":sns_039:", 9],
    ] as const) {
      const content = "a".repeat(500 - length) + suffix;
      expect(commentContentSchema.parse(content)).toBe(content);
      expect(commentContentSchema.safeParse(content + "a").success).toBe(false);
    }
  });

  it("trims before applying content rules and rejects content that becomes blank", () => {
    const content = "中".repeat(500);
    expect(commentContentSchema.parse(` \n${content}\t `)).toBe(content);
    expect(commentContentSchema.safeParse(" \n\t ").success).toBe(false);
  });
});

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
