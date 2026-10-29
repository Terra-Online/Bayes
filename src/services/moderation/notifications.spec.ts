import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { processWebhookQueueBatch } from "@/queues/runtime/moderationWebhook";
import type { WebhookMsg } from "@/queues/types/messages";
import type { SubmissionRecord } from "@/repositories/submission/types";
import type { Bindings } from "@/types/app";

import type { ModerationNotificationEvent } from "./messages";
import { sendModerationNotificationNow } from "./notifications";

const submission: SubmissionRecord = {
  id: "submission-1",
  kind: "comment",
  markerId: "marker-1",
  poiHash: "poi-hash",
  poiType: "marker",
  snapshotId: "snapshot-1",
  userId: "user-1",
  content: "Test comment",

  filePath: null,
  status: "pending_openai",
  flagCount: 0,
  mimeType: null,
  sizeBytes: null,
  parentId: null,
  commentDepth: 0,
  submitter: null,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};

const event: ModerationNotificationEvent = {
  type: "submission_moderation_result",
  submission,
  previousStatus: "pending_openai",
  nextStatus: "pending_audit",
  source: "auto_moderation",
};

interface WebhookDeliveryFixture {
  batch: MessageBatch<WebhookMsg>;
  ack: Mock<() => void>;
  retry: Mock<() => void>;
}

function createWebhookDelivery(): WebhookDeliveryFixture {
  const ack = vi.fn<() => void>();
  const retry = vi.fn<() => void>();
  const message = {
    body: {
      type: "discord_notification",
      event,
      queuedAt: "2026-09-10T00:00:00.000Z",
    },
    ack,
    retry,
  };
  const batch = {
    queue: "oem-webhook",
    messages: [message],
  } as unknown as MessageBatch<WebhookMsg>;
  return { batch, ack, retry };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Discord moderation notifications", () => {
  it.each(["http", "network"])(
    "retries a %s delivery failure and acknowledges only successful delivery",
    async (failure) => {
      const { batch, ack, retry } = createWebhookDelivery();
      const requests: Request[] = [];
      const fetchWebhook = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        requests.push(new Request(input, init));
        if (requests.length === 1) {
          if (failure === "network") {
            throw new Error("connection reset");
          }
          return new Response("temporarily unavailable", { status: 503 });
        }
        return new Response(null, { status: 204 });
      });
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const env = {
        DISCORD_MODERATION_WEBHOOK_URL: "https://discord.example.test/webhook",
      } as Bindings;
      await processWebhookQueueBatch(env, batch);
      expect(retry).toHaveBeenCalledOnce();
      expect(ack).not.toHaveBeenCalled();
      // Redelivery must succeed before the queue can discard this moderation result.
      await processWebhookQueueBatch(env, batch);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).toHaveBeenCalledOnce();
      expect(fetchWebhook).toHaveBeenCalledTimes(2);
      expect(requests[1]!.url).toBe("https://discord.example.test/webhook");
      expect(await requests[1]!.json()).toMatchObject({
        embeds: [
          expect.objectContaining({
            fields: expect.arrayContaining([
              expect.objectContaining({ name: "submission", value: submission.id }),
              expect.objectContaining({ name: "status", value: "pending_openai -> pending_audit" }),
            ]),
          }),
        ],
      });
    },
  );

  it.each([
    ["image", "12345"],
    ["comment", "12345"],
    ["image", "marker /+1"],
    ["comment", "marker /+1"],
  ] as const)(
    "links directly to the %s and its Cor review for marker %s",
    async (kind, markerId) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      const id = "submission /+1";
      await sendModerationNotificationNow(
        {
          DISCORD_MODERATION_WEBHOOK_URL: "https://discord.example.test/webhook",
        } as Bindings,
        { ...event, submission: { ...submission, id, kind, markerId } },
      );

      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      const fields = payload.embeds[0].fields as { name: string; value: string }[];
      const content = fields.find((field) => field.name === "content")!.value;
      const review = fields.find((field) => field.name === "review")!.value;
      const contentUrl = new URL(content.match(/\]\(([^)]+)\)/)![1]!);
      const reviewUrl = new URL(review.match(/\]\(([^)]+)\)/)![1]!);
      expect(contentUrl.origin).toBe("https://oem.re");
      expect(contentUrl.searchParams.get(kind === "image" ? "imageId" : "commentId")).toBe(id);
      expect(contentUrl.searchParams.has(kind === "image" ? "commentId" : "imageId")).toBe(false);
      if (markerId === "12345") {
        expect(contentUrl.pathname).toMatch(/^\/[a-zA-Z0-9]{7}$/);
      } else {
        expect(contentUrl.searchParams.get("p")).toBe(markerId);
        expect(contentUrl.searchParams.get("type")).toBe(submission.poiType);
      }
      expect(reviewUrl.origin).toBe("https://admin.opendfieldmap.org");
      expect(reviewUrl.searchParams.get("submissionId")).toBe(id);
    },
  );

  it("fails when the webhook secret is missing", async () => {
    await expect(sendModerationNotificationNow({} as Bindings, event)).rejects.toThrow(
      "DISCORD_MODERATION_WEBHOOK_URL is not configured",
    );
  });

  it("retries the queue message instead of acknowledging missing webhook configuration", async () => {
    const { batch, ack, retry } = createWebhookDelivery();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await processWebhookQueueBatch({} as Bindings, batch);

    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      "OEM_WEBHOOK_Q message failed",
      expect.objectContaining({
        eventType: "submission_moderation_result",
        error: "DISCORD_MODERATION_WEBHOOK_URL is not configured",
      }),
    );
  });
});
