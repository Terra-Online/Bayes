import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranslationMsg } from "@/queues/types/messages";
import { createMockBindings } from "@/test/bindings";
import {
  createCommentTranslationFixture,
  createTranslationSigningKey,
  type CommentTranslationFixture,
} from "@/test/fixtures/commentTranslation";
import { insertSubmission } from "@/test/fixtures/submissions";

import { processTranslationQueueBatch } from "./commentTranslation";

interface TranslationDelivery {
  batch: MessageBatch<TranslationMsg>;
  ack: ReturnType<typeof vi.fn<() => void>>;
  retry: ReturnType<typeof vi.fn<() => void>>;
}

function createDelivery(): TranslationDelivery {
  const ack = vi.fn<() => void>();
  const retry = vi.fn<() => void>();
  return {
    batch: {
      queue: "oem-translation",
      messages: [
        {
          body: {
            type: "comment_translation_prewarm",
            submissionId: "comment",
            source: "auto_moderation",
            queuedAt: "2026-10-24T00:00:00.000Z",
          },
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<TranslationMsg>,
    ack,
    retry,
  };
}

let fixture: CommentTranslationFixture;
let webhookQueue: ReturnType<typeof createMockBindings>["webhookQueue"];

beforeEach(async () => {
  fixture = createCommentTranslationFixture({
    privateKey: await createTranslationSigningKey(),
    translatedText: "Translated comment",
  });
  fixture.env.ENABLE_COMMENT_TRANSLATION_PREWARM = "true";
  webhookQueue = createMockBindings({ DB: fixture.database.db }).webhookQueue;
  fixture.env.OEM_WEBHOOK_Q = webhookQueue;
  insertSubmission(fixture.database.sqlite, {
    id: "comment",
    userId: "author",
    content: "测试评论",
  });
  vi.stubGlobal("fetch", fixture.providerFetch);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

vi.mock("cloudflare:workers", () => ({
  exports: {},
  DurableObject: class {},
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {},
}));

afterEach(() => {
  fixture.database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("comment translation queue delivery", () => {
  it("acknowledges failed translation targets and reports them in the completion notification", async () => {
    fixture.provider.translationResponse = () => new Response("unavailable", { status: 503 });
    webhookQueue.send.mockResolvedValue({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
    });
    const { batch, ack, retry } = createDelivery();

    await processTranslationQueueBatch(fixture.env, batch);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(fixture.storedTranslations()).toEqual([]);
    expect(webhookQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "comment_translation_prewarm_completed",
          targets: ["zh-CN", "en-US", "ru-RU", "ja-JP", "ko-KR"].map((lang) => ({
            lang,
            status: "failed",
            error: "Google Translation request failed (503). unavailable",
          })),
        }),
      }),
    );
  });

  it("retries notification enqueue failure and reuses persisted translations on redelivery", async () => {
    webhookQueue.send
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValue({ metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } } });
    const { batch, ack, retry } = createDelivery();

    await processTranslationQueueBatch(fixture.env, batch);

    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    // Chinese is the source language; only the other four targets produce durable translations.
    expect(fixture.storedTranslations()).toHaveLength(4);
    fixture.translationRequests.length = 0;

    await processTranslationQueueBatch(fixture.env, batch);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(fixture.storedTranslations()).toHaveLength(4);
    expect(fixture.translationRequests).toEqual([
      expect.objectContaining({ targetLanguageCode: "zh-CN" }),
    ]);
    expect(webhookQueue.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "comment_translation_prewarm_completed",
          targets: expect.arrayContaining([
            { lang: "en-US", status: "success", cached: true },
            { lang: "ru-RU", status: "success", cached: true },
            { lang: "ja-JP", status: "success", cached: true },
            { lang: "ko-KR", status: "success", cached: true },
          ]),
        }),
      }),
    );
  });
});
