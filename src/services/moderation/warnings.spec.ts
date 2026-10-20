import { beforeEach, describe, expect, it, vi } from "vitest";

import { SqliteD1 } from "../../test/sqliteD1";
import type { Bindings } from "../../types/app";

const sendEmail = vi.hoisted(() => vi.fn());

vi.mock("../../lib/email/sender", () => ({
  sendEmail,
}));

import { sendModerationWarning } from "./warnings";

describe("moderation warning service", () => {
  let database: SqliteD1;

  beforeEach(() => {
    sendEmail.mockReset().mockResolvedValue({ provider: "cloudflare", id: "message-1" });
    database = new SqliteD1();
    database.sqlite.exec(`
      CREATE TABLE users (
        uid TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, role TEXT, karma INTEGER DEFAULT 0,
        avt INTEGER, nickname TEXT UNIQUE, nickname_customized INTEGER, uid_number INTEGER UNIQUE,
        uid_suffix TEXT, email_verified TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_active TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users (
        uid, email, password_hash, role, nickname, nickname_customized, uid_number, uid_suffix
      ) VALUES ('user-1', 'user@example.test', 'managed', 'n', 'Tester', 1, 103427, 'VA');
    `);
  });

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
