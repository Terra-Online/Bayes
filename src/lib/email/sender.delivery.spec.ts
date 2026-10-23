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
});
