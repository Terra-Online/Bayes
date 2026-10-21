import { describe, expect, it } from "vitest";

import { commentEditSchema, commentSubmissionSchema } from "@/routes/schema/uploads";
import { getCommentLength } from "@/services/upload/commentLength";

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
