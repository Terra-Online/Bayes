import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubmissionRecord } from "@/repositories/submission/types";
import type { Bindings } from "@/types/app";

import type { ModerationNotificationEvent, OemWebhookQueueMessage } from "./messages";
import { processWebhookQueueBatch, sendModerationNotificationNow } from "./notifications";

const submission: SubmissionRecord = {
  id: "submission-1",
  kind: "comment",
  markerId: "marker-1",
  poiHash: "poi-hash",
  poiType: "marker",
  snapshotId: "snapshot-1",
  userId: "user-1",
  content: "Test comment",
  editOriginalContent: null,
  editOriginalStatus: null,
  editOriginalSnapshotId: null,
  filePath: null,
  status: "pending_openai",
  flagCount: 0,
  moderationNote: null,
  moderationQueuedAt: null,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Discord moderation notifications", () => {
  it.each(["http", "network"])(
    "retries a %s delivery failure and acknowledges only successful delivery",
    async (failure) => {
      const ack = vi.fn();
      const retry = vi.fn();
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
      } as unknown as MessageBatch<OemWebhookQueueMessage>;
      const requests: Request[] = [];
      const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
      await processWebhookQueueBatch(env, batch);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(2);
      expect(requests[1]!.url).toBe("https://discord.example.test/webhook");
      expect(await requests[1]!.json()).toMatchObject({
        embeds: [
          expect.objectContaining({
            fields: expect.arrayContaining([
              expect.objectContaining({ value: submission.id }),
              expect.objectContaining({ value: "pending_openai -> pending_audit" }),
            ]),
          }),
        ],
      });
    },
  );
  it("fails when the webhook secret is missing", async () => {
    await expect(sendModerationNotificationNow({} as Bindings, event)).rejects.toThrow(
      "DISCORD_MODERATION_WEBHOOK_URL is not configured",
    );
  });

  it("retries the queue message instead of acknowledging missing webhook configuration", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    } as unknown as MessageBatch<OemWebhookQueueMessage>;

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
