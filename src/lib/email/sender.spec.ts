import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "../../types/app";

const resendSend = vi.hoisted(() => vi.fn());
const redisGet = vi.hoisted(() => vi.fn());
const redisIncr = vi.hoisted(() => vi.fn());
const redisExpire = vi.hoisted(() => vi.fn());
const redisSet = vi.hoisted(() => vi.fn());
const redisDecr = vi.hoisted(() => vi.fn());

vi.mock("resend", () => ({
  Resend: vi.fn(() => ({ emails: { send: resendSend } })),
}));

vi.mock("../redis", () => ({
  createRedisClient: vi.fn(() => ({
    get: redisGet,
    incr: redisIncr,
    expire: redisExpire,
    set: redisSet,
    decr: redisDecr,
  })),
}));

import { sendEmail } from "./sender";

function makeEnv(
  input: {
    slotAvailable?: boolean;
    cloudflareSend?: ReturnType<typeof vi.fn>;
    mode?: string;
  } = {},
): Bindings {
  const cloudflareSend =
    input.cloudflareSend ?? vi.fn().mockResolvedValue({ messageId: "cf-message-id" });
  return {
    DB: {} as D1Database,
    OEM_ID_MAILS: { send: cloudflareSend } as unknown as SendEmail,
    EMAIL_PROVIDER_MODE: input.mode,
    EMAIL_RESEND_DAILY_LIMIT: "100",
    RESEND_AUTH_KEY: "test-key",
    EMAIL_FROM_EMAIL: "noreply@example.com",
    EMAIL_FROM_NAME: "Test",
  } as unknown as Bindings;
}

describe("email provider fallback", () => {
  beforeEach(() => {
    resendSend.mockReset();
    redisGet.mockReset().mockResolvedValue(null);
    redisIncr.mockReset().mockResolvedValue(1);
    redisExpire.mockReset().mockResolvedValue(1);
    redisSet.mockReset().mockResolvedValue("OK");
    redisDecr.mockReset().mockResolvedValue(0);
  });

  it("uses Resend while a daily quota slot is available", async () => {
    resendSend.mockResolvedValue({ data: { id: "resend-message-id" }, error: null });
    redisIncr.mockResolvedValue(1);
    const env = makeEnv();

    await expect(
      sendEmail(
        {
          to: "user@example.com",
          subject: "Subject",
          text: "Text",
          html: "<p>Text</p>",
        },
        env,
      ),
    ).resolves.toEqual({ provider: "resend", id: "resend-message-id" });
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Test <noreply@example.com>",
        to: "user@example.com",
      }),
    );
  });

  it("supports a per-message sender override", async () => {
    resendSend.mockResolvedValue({ data: { id: "resend-message-id" }, error: null });
    const env = makeEnv();

    await expect(
      sendEmail(
        {
          to: "user@example.com",
          from: "moderation@opendfieldmap.org",
          subject: "Warning",
          text: "Text",
        },
        env,
      ),
    ).resolves.toEqual({ provider: "resend", id: "resend-message-id" });
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "moderation@opendfieldmap.org",
      }),
    );
  });

  it("uses Cloudflare after the local daily quota is exhausted", async () => {
    const cloudflareSend = vi.fn().mockResolvedValue({ messageId: "cf-message-id" });
    redisGet.mockResolvedValue("1");
    const env = makeEnv({ slotAvailable: false, cloudflareSend });

    await expect(
      sendEmail({ to: "user@example.com", subject: "Subject", text: "Text" }, env),
    ).resolves.toEqual({ provider: "cloudflare", id: "cf-message-id" });
    expect(resendSend).not.toHaveBeenCalled();
    expect(cloudflareSend).toHaveBeenCalledTimes(1);
  });

  it("falls back on an explicit Resend daily quota error", async () => {
    resendSend.mockResolvedValue({
      data: null,
      error: { name: "daily_quota_exceeded", statusCode: 429, message: "Daily quota exceeded" },
    });
    redisIncr.mockResolvedValue(1);
    const cloudflareSend = vi.fn().mockResolvedValue({ messageId: "cf-message-id" });
    const env = makeEnv({ cloudflareSend });

    await expect(
      sendEmail({ to: "user@example.com", subject: "Subject", text: "Text" }, env),
    ).resolves.toEqual({ provider: "cloudflare", id: "cf-message-id" });
    expect(cloudflareSend).toHaveBeenCalledTimes(1);
  });

  it("falls back on an explicit Resend temporary server error", async () => {
    resendSend.mockResolvedValue({
      data: null,
      error: { name: "internal_server_error", statusCode: 500, message: "Temporary failure" },
    });
    const cloudflareSend = vi.fn().mockResolvedValue({ messageId: "cf-message-id" });
    const env = makeEnv({ cloudflareSend });

    await expect(
      sendEmail({ to: "user@example.com", subject: "Subject", text: "Text" }, env),
    ).resolves.toEqual({ provider: "cloudflare", id: "cf-message-id" });
    expect(cloudflareSend).toHaveBeenCalledTimes(1);
  });

  it("supports an explicit Cloudflare-only mode without constructing Resend", async () => {
    const cloudflareSend = vi.fn().mockResolvedValue({ messageId: "cf-message-id" });
    const env = makeEnv({ mode: "cloudflare_only", cloudflareSend });

    await expect(
      sendEmail({ to: "user@example.com", subject: "Subject", text: "Text" }, env),
    ).resolves.toEqual({ provider: "cloudflare", id: "cf-message-id" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("does not fall back on permanent Resend configuration errors", async () => {
    resendSend.mockResolvedValue({
      data: null,
      error: { name: "invalid_api_key", statusCode: 401, message: "Invalid API key" },
    });
    redisIncr.mockResolvedValue(1);
    const cloudflareSend = vi.fn();
    const env = makeEnv({ cloudflareSend });

    await expect(
      sendEmail({ to: "user@example.com", subject: "Subject", text: "Text" }, env),
    ).rejects.toThrow("Invalid API key");
    expect(cloudflareSend).not.toHaveBeenCalled();
  });

  it("does not fall back when the Resend result is ambiguous after a timeout", async () => {
    resendSend.mockRejectedValue(new Error("request timed out"));
    redisIncr.mockResolvedValue(1);
    const cloudflareSend = vi.fn();
    const env = makeEnv({ cloudflareSend });

    await expect(
      sendEmail({ to: "user@example.com", subject: "Subject", text: "Text" }, env),
    ).rejects.toThrow("request timed out");
    expect(cloudflareSend).not.toHaveBeenCalled();
  });

  it("keeps sender, quota and provider bound while another environment sends", async () => {
    let release!: (value: null) => void;
    redisGet.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    resendSend.mockResolvedValue({ data: { id: "first-delivery" }, error: null });
    const first = { ...makeEnv(), EMAIL_FROM_NAME: "First", EMAIL_RESEND_DAILY_LIMIT: "1" };
    const secondSend = vi.fn().mockResolvedValue({ messageId: "second-delivery" });
    const second = {
      ...makeEnv({ mode: "cloudflare_only", cloudflareSend: secondSend }),
      EMAIL_FROM_NAME: "Second",
    };
    const pending = sendEmail({ to: "first@example.test", subject: "First", text: "First" }, first);
    await sendEmail({ to: "second@example.test", subject: "Second", text: "Second" }, second);
    release(null);
    await expect(pending).resolves.toMatchObject({ provider: "resend", id: "first-delivery" });
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: "First <noreply@example.com>" }),
    );
    expect(secondSend).toHaveBeenCalledTimes(1);
    expect(secondSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Second <noreply@example.com>" }),
    );
  });
});
