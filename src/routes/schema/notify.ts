import { z } from "zod";

import type { SerializedNotificationItem } from "@/repositories/notifications";

export const listQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  unreadOnly: z.enum(["0", "1"]).optional(),
});

export const readManySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(100),
});

export const unreadCountsSchema = z.object({
  system: z.number(),
  community: z.number(),
  total: z.number(),
});
export const notificationItemSchema: z.ZodType<SerializedNotificationItem> = z
  .object({
    id: z.string(),
    type: z.enum([
      "system.submission.approved",
      "system.submission.needs_review",
      "system.remove_request.resolved",
      "community.comment.reply",
      "community.comment.vote",
    ]),
    payload: z.object({
      kind: z.enum(["image", "comment"]).optional(),
      messageCount: z.number().optional(),
    }),
    target: z.object({
      submissionId: z.string().nullable(),
      parentSubmissionId: z.string().nullable(),
      markerId: z.string().nullable(),
      poiHash: z.string().nullable(),
      poiType: z.string().nullable(),
    }),
    readAt: z.string().nullable(),
    createdAt: z.string(),
    isMultiMsg: z.boolean(),
    messages: z.array(z.lazy(() => notificationItemSchema)),
  })
  .meta({ ref: "Notification" });
export const notificationListResponseSchema = z.object({
  items: z.array(notificationItemSchema),
  nextCursor: z.string().nullable(),
  unread: unreadCountsSchema,
});
export const notificationReadResponseSchema = z.object({
  ok: z.literal(true),
  changed: z.number(),
  unread: unreadCountsSchema,
});
export const notificationReadOneResponseSchema = notificationReadResponseSchema.extend({
  changed: z.boolean(),
});
export const unreadResponseSchema = z.object({ unread: unreadCountsSchema });
