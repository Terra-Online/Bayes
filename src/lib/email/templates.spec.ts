import { describe, expect, it } from "vitest";

import { createModerationWarningEmailTemplate } from "./templates";

describe("moderation warning email template", () => {
  it("renders the concise English warning with the detected behavior and policy links", () => {
    const content = createModerationWarningEmailTemplate({
      displayName: "Foo Bar",
      publicUid: "10FOOO0",
    });

    expect(content.subject).toBe("[OEM Moderation] Warning: Repeated Link-Only Posts");
    expect(content.text).toContain("Hello Foo Bar,");
    expect(content.text).toContain("Open Endfield Map account 10FOOO0.");
    expect(content.text).toContain(
      "We detected repeated or bulk posting of context-free external links in the discussion area.",
    );
    expect(content.text).toContain("https://blog.opendfieldmap.org/docs/community-guidelines");
    expect(content.text).toContain("https://blog.opendfieldmap.org/docs/ugc");
    expect(content.text).toContain(
      "This is a moderation warning. Further violations may result in account suspension.",
    );
    expect(content.text).toContain("reply to this email to appeal.");
    expect(content.text).not.toMatch(/\b\d+\s+(?:posts?|comments?|links?)\b/i);
    expect(content.html).toContain("moderation@opendfieldmap.org");
    expect(content.html).toContain("https://blog.opendfieldmap.org/docs/community-guidelines");
    expect(content.html).toContain("https://blog.opendfieldmap.org/docs/ugc");
    expect(content.html).toContain("10FOOO0");
  });

  it("escapes user and policy values in HTML", () => {
    const content = createModerationWarningEmailTemplate({
      displayName: "<name>",
      publicUid: "<uid>",
    });

    expect(content.html).toContain("&lt;name&gt;");
    expect(content.html).toContain("&lt;uid&gt;");
  });
});
