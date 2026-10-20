import { describe, expect, it } from "vitest";

import { getCommentLength } from "./commentLength";
import { commentEditSchema, commentSubmissionSchema } from "./schemas";

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

describe.each([
  [
    "new comments",
    (content: string) =>
      commentSubmissionSchema.safeParse({
        markerId: "marker-1",
        poiHash: "hash",
        poiType: "poi",
        content,
      }),
  ],
  ["comment edits", (content: string) => commentEditSchema.safeParse({ content })],
] as const)("%s", (_name, parse) => {
  it("accepts 500 text units and rejects 501", () => {
    expect(parse("中".repeat(500)).success).toBe(true);
    expect(parse("中".repeat(501)).success).toBe(false);
    expect(parse("😀".repeat(250)).success).toBe(true);
    expect(parse("😀".repeat(250) + "a").success).toBe(false);
  });

  it("allows 250 rendered emojis even though their source exceeds 500 characters", () => {
    const content = ":sns_001:".repeat(250);
    const parsed = parse(content);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Emoji content was rejected");
    }
    expect(parsed.data.content).toBe(content);
    expect(parse(content + ":sns_038:").success).toBe(false);
  });

  it("enforces the same boundary for mixed text, formats, code, links and escapes", () => {
    for (const suffix of [
      ":sns_038:",
      "**:sns_001:**",
      "`:sns_001:`",
      "\\:sns_001:",
      "[:sns_001:](https://example.com)",
      "[label](https://example.com/:sns_001:)",
      ":sns_000:",
      ":sns_039:",
    ]) {
      const atLimit = "a".repeat(500 - getCommentLength(suffix)) + suffix;
      expect(parse(atLimit).success, suffix).toBe(true);
      expect(parse(atLimit + "a").success, suffix).toBe(false);
    }
  });

  it("preserves trimming and rejects blank or excessively long source", () => {
    const parsed = parse("  hello  ");
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Trimmed content was rejected");
    }
    expect(parsed.data.content).toBe("hello");
    expect(parse(" \n\t ").success).toBe(false);
    expect(parse(":sns_001:".repeat(251)).success).toBe(false);
  });
});
