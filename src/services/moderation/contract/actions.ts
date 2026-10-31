import { z } from "zod";

const version = { snapshotId: z.string().trim().min(1).max(64) };
const review = {
  ...version,
  expectedReviewStatus: z.enum([
    "pending_openai",
    "pending_audit",
    "approved",
    "rejected",
    "unknown",
  ]),
  note: z.string().trim().max(500).optional(),
};
export const managementActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), ...review }),
  z.object({ action: z.literal("reject"), ...review }),
  z.object({ action: z.literal("send_to_manual"), ...review }),
  z.object({ action: z.literal("disable"), ...version }),
  z.object({ action: z.literal("clear_flags"), ...version }),
]);
export type ManagementAction = z.infer<typeof managementActionSchema>;
