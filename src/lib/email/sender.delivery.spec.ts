import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { Bindings } from "@/types/app";

import { sendEmail } from "./sender";

describe("email delivery through provider interfaces", () => {
  let env: Bindings;
  let database: TestDatabase;
  let cloudflareSend: MockBindings["idMails"]["send"];
  let resendResponse: Mock<() => Promise<Response>>;
  let failsRedisCommand: (command: unknown[]) => boolean;
  let redisValues: Map<string, number | string>;
  let resendMessages: unknown[];
  const message = {
    to: "recipient@example.com",
    subject: "Your verification code",
    text: "Your code is 123456.",
    html: "<p>Your code is <b>123456</b>.</p>",
  };

  beforeEach(() => {
    redisValues = new Map();
    database = createTestDatabase();
    const external = createMockBindings({ DB: database.db });
    resendMessages = [];
    failsRedisCommand = () => false;
    cloudflareSend = external.idMails.send.mockResolvedValue({ messageId: "fallback-id" });
    resendResponse = vi.fn<() => Promise<Response>>(async () =>
      Response.json({ id: "primary-id" }),
    );
    env = {
      ...external.bindings,
      EMAIL_PROVIDER_MODE: "resend_then_cloudflare",
      RESEND_AUTH_KEY: "test-key",
      EMAIL_FROM_EMAIL: "noreply@example.com",
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api.resend.com/emails") {
        resendMessages.push(JSON.parse(String(init?.body)));
        return resendResponse();
      }
      if (!url.startsWith("https://redis.example.test/")) {
        throw new Error(`Unexpected provider request: ${url}`);
      }
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      return Response.json(
        commands.map((command) => {
          if (failsRedisCommand(command)) {
            return { error: "Redis unavailable" };
          }
          const [operation, rawKey, value] = command;
          const key = String(rawKey);
          if (operation === "get") {
            return { result: redisValues.get(key) ?? null };
          }
          if (operation === "set") {
            redisValues.set(key, String(value));
            return { result: "OK" };
          }
          if (operation === "incr" || operation === "decr") {
            const count = Number(redisValues.get(key) ?? 0) + (operation === "incr" ? 1 : -1);
            redisValues.set(key, count);
            return { result: count };
          }
          if (operation === "expire") {
            return { result: 1 };
          }
          throw new Error(`Unexpected Redis command: ${operation}`);
        }),
      );
    });
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  it("reports both providers failing and can deliver the unchanged message on retry", async () => {
    resendResponse.mockResolvedValueOnce(
      Response.json({ name: "internal_server_error", message: "Unavailable" }, { status: 503 }),
    );
    cloudflareSend.mockRejectedValueOnce(
      Object.assign(new Error("Delivery rejected"), { code: "EMAIL_SEND_FAILED" }),
    );
    await expect(sendEmail(message, env)).rejects.toMatchObject({
      provider: "cloudflare",
      providerCode: "both_providers_failed",
      message: expect.stringContaining("EMAIL_SEND_FAILED"),
    });
    expect(cloudflareSend).toHaveBeenCalledWith({ ...message, from: "noreply@example.com" });
    await expect(sendEmail(message, env)).resolves.toEqual({
      provider: "resend",
      id: "primary-id",
    });
    expect(resendMessages).toEqual([
      { ...message, from: "noreply@example.com" },
      { ...message, from: "noreply@example.com" },
    ]);
  });

  it("avoids duplicate delivery when the real Resend SDK loses a timed-out response, and permits a later explicit retry", async () => {
    // Acceptance is unknown after a timeout; automatic fallback could send the same mail twice.
    resendResponse.mockRejectedValueOnce(new DOMException("The request timed out", "TimeoutError"));
    await expect(sendEmail(message, env)).rejects.toMatchObject({
      provider: "resend",
      kind: "ambiguous",
    });
    expect(cloudflareSend).not.toHaveBeenCalled();
    await expect(sendEmail(message, env)).resolves.toEqual({
      provider: "resend",
      id: "primary-id",
    });
  });

  it("enforces the configured daily allowance and keeps later messages on fallback", async () => {
    env.EMAIL_RESEND_DAILY_LIMIT = "2";
    await expect(sendEmail(message, env)).resolves.toMatchObject({ provider: "resend" });
    await expect(sendEmail(message, env)).resolves.toMatchObject({ provider: "resend" });
    await expect(sendEmail(message, env)).resolves.toMatchObject({ provider: "cloudflare" });
    await expect(sendEmail(message, env)).resolves.toMatchObject({ provider: "cloudflare" });
    expect(resendMessages).toHaveLength(2);
    expect(cloudflareSend.mock.calls.map(([payload]) => payload)).toEqual([
      { ...message, from: "noreply@example.com" },
      { ...message, from: "noreply@example.com" },
    ]);
  });

  it("reports exhausted quota when fallback is unavailable and recovers when the binding is supplied", async () => {
    env.EMAIL_RESEND_DAILY_LIMIT = "1";
    Reflect.deleteProperty(env, "OEM_ID_MAILS");
    await sendEmail(message, env);
    await expect(sendEmail(message, env)).rejects.toMatchObject({
      kind: "quota",
      providerCode: "daily_quota_exceeded",
    });
    env.OEM_ID_MAILS = { send: cloudflareSend };
    await expect(sendEmail(message, env)).resolves.toMatchObject({ provider: "cloudflare" });
    expect(resendMessages).toHaveLength(1);
  });

  it("does not use fallback when the supported legacy setting disables it", async () => {
    env.EMAIL_PROVIDER_MODE = undefined;
    env.EMAIL_FALLBACK_ENABLED = "false";
    resendResponse.mockResolvedValueOnce(
      Response.json(
        { name: "internal_server_error", message: "Unavailable", statusCode: 503 },
        { status: 503 },
      ),
    );
    await expect(sendEmail(message, env)).rejects.toMatchObject({
      provider: "resend",
      kind: "temporary",
    });
    expect(cloudflareSend).not.toHaveBeenCalled();
    await expect(sendEmail(message, env)).resolves.toMatchObject({ provider: "resend" });
  });

  it("requires a Cloudflare binding for the legacy Cloudflare-primary setting and delivers after configuration is repaired", async () => {
    env.EMAIL_PROVIDER_MODE = undefined;
    env.EMAIL_PRIMARY_PROVIDER = "cloudflare";
    Reflect.deleteProperty(env, "OEM_ID_MAILS");
    await expect(sendEmail(message, env)).rejects.toThrow("CLOUDFLARE_EMAIL_NOT_CONFIGURED");
    expect(resendMessages).toEqual([]);
    env.OEM_ID_MAILS = { send: cloudflareSend };
    await expect(sendEmail(message, env)).resolves.toEqual({
      provider: "cloudflare",
      id: "fallback-id",
    });
    expect(cloudflareSend).toHaveBeenCalledWith({ ...message, from: "noreply@example.com" });
  });

  it("safely rejects malformed provider error details without sending a duplicate through fallback", async () => {
    resendResponse.mockResolvedValueOnce(Response.json({}, { status: 400 }));
    await expect(sendEmail(message, env)).rejects.toMatchObject({
      provider: "resend",
      kind: "permanent",
      providerCode: "unknown_error",
    });
    expect(cloudflareSend).not.toHaveBeenCalled();
    await expect(sendEmail(message, env)).resolves.toEqual({
      provider: "resend",
      id: "primary-id",
    });
  });

  it("preserves a configured sender's display name when environment quoting is removed", async () => {
    env.EMAIL_FROM_EMAIL = "'\"Mail Team\" <sender@example.com>'";
    env.EMAIL_FROM_NAME = "Unused default name";
    await expect(sendEmail(message, env)).resolves.toMatchObject({ provider: "resend" });
    expect(resendMessages).toEqual([{ ...message, from: "Mail Team <sender@example.com>" }]);
  });

  it.each(["quota reservation", "success metrics"])(
    "keeps successful delivery available during a Redis %s outage",
    async (outage) => {
      failsRedisCommand = ([operation, key]) =>
        outage === "quota reservation"
          ? operation === "get"
          : operation === "incr" && String(key).endsWith(":success");
      await expect(sendEmail(message, env)).resolves.toEqual({
        provider: "resend",
        id: "primary-id",
      });
      failsRedisCommand = () => false;
      await expect(sendEmail(message, env)).resolves.toEqual({
        provider: "resend",
        id: "primary-id",
      });
      expect(resendMessages).toEqual([
        { ...message, from: "noreply@example.com" },
        { ...message, from: "noreply@example.com" },
      ]);
      expect(cloudflareSend).not.toHaveBeenCalled();
    },
  );

  it.each(["reservation release", "quota marking", "fallback metrics"])(
    "keeps fallback delivery available during a Redis %s outage",
    async (outage) => {
      const quotaFailure = outage === "quota marking";
      resendResponse.mockResolvedValueOnce(
        Response.json(
          {
            name: quotaFailure ? "daily_quota_exceeded" : "internal_server_error",
            message: quotaFailure ? "Daily quota exceeded" : "Unavailable",
            statusCode: quotaFailure ? 429 : 503,
          },
          { status: quotaFailure ? 429 : 503 },
        ),
      );
      failsRedisCommand = ([operation, key]) => {
        if (outage === "reservation release") {
          return operation === "decr";
        }
        if (outage === "quota marking") {
          return operation === "set" && String(key).endsWith(":exhausted");
        }
        return operation === "incr" && String(key).endsWith(":fallback");
      };
      await expect(sendEmail(message, env)).resolves.toEqual({
        provider: "cloudflare",
        id: "fallback-id",
      });
      expect(cloudflareSend).toHaveBeenCalledWith({ ...message, from: "noreply@example.com" });
      failsRedisCommand = () => false;
      await expect(sendEmail(message, env)).resolves.toEqual({
        provider: "resend",
        id: "primary-id",
      });
    },
  );
});
