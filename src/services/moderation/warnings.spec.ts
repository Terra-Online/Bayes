import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertUser } from "@/test/fixtures/users";
import type { Bindings } from "@/types/app";

const sendEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/email/sender", () => ({
  sendEmail,
}));

import { sendModerationWarning } from "./warnings";

describe("moderation warning service", () => {
  let database: TestDatabase;

  beforeEach(() => {
    sendEmail.mockReset().mockResolvedValue({ provider: "cloudflare", id: "message-1" });
    database = createTestDatabase();
    insertUser(database.sqlite, {
      uid: "user-1",
      email: "user@example.test",
      nickname: "Tester",
      uid_number: 103427,
      uid_suffix: "VA",
    });
  });

  afterEach(() => database.close());

  it("sends a warning using the resolved account and moderation sender", async () => {
    await expect(
      sendModerationWarning({ DB: database.db } as Bindings, { publicUid: "103427VA" }),
    ).resolves.toMatchObject({ publicUid: "103427VA" });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.test",
        from: "OEM Moderation <moderation@opendfieldmap.org>",
        subject: "[OEM Moderation] Warning: Repeated Link-Only Posts",
      }),
      expect.objectContaining({ DB: database.db }),
    );
    const payload = sendEmail.mock.calls[0]![0] as { text: string };
    expect(payload.text).toContain("Open Endfield Map account 103427VA.");
    expect(payload.text).toContain("https://blog.opendfieldmap.org/docs/community-guidelines");
    expect(payload.text).toContain("https://blog.opendfieldmap.org/docs/ugc");
    expect(payload.text).not.toMatch(/\b\d+\s+(?:posts?|comments?|links?)\b/i);
  });

  it("does not send when the public UID does not resolve", async () => {
    await expect(
      sendModerationWarning({ DB: database.db } as Bindings, { publicUid: "999999ZZ" }),
    ).resolves.toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
