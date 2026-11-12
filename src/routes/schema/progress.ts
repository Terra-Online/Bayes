import { z } from "zod";

// The domain normalizers own manifest hashing, canonical ordering, and patch
// semantics. These HTTP schemas describe their wire inputs without revalidating.
const hashSchema = z
  .string()
  .describe("SHA-256 hex hash of the canonical manifest; trimmed and lowercased by the server.");
export const markerManifestSchema = z.object({
  markerIndexHash: hashSchema,
  pointIds: z.array(z.string()).min(1),
});
export const archiveManifestSchema = z.object({
  archiveIndexHash: hashSchema,
  archiveIds: z.array(z.string().max(256)).min(1).max(20000).describe("Sorted unique archive IDs."),
});
export const markerStateQuerySchema = z.object({ markerIndexHash: hashSchema });
export const archiveStateQuerySchema = z.object({ archiveIndexHash: hashSchema });
export const markerSyncSchema = z.object({
  baseRevision: z
    .string()
    .optional()
    .describe(
      "Revision of the state this patch was prepared against. Use the latest state response; an absent or empty value represents an initial state.",
    ),
  clientMutationId: z
    .string()
    .describe(
      "Identity of this mutation. Reuse with the identical request on a network retry; use a new identity after reconciliation.",
    ),
  markerIndexHash: hashSchema,
  setPointIds: z.array(z.string()).optional(),
  clearPointIds: z.array(z.string()).optional(),
  updatedAt: z.number().min(0).describe("Client modification time in epoch milliseconds."),
});
export const archiveSyncSchema = z.object({
  baseRevision: z
    .string()
    .optional()
    .describe(
      "Revision of the state this patch was prepared against. Use the latest state response; an absent or empty value represents an initial state.",
    ),
  clientMutationId: z
    .string()
    .describe(
      "Identity of this mutation. Reuse with the identical request on a network retry; use a new identity after reconciliation.",
    ),
  archiveIndexHash: hashSchema,
  setArchiveIds: z.array(z.string()).max(20000).optional(),
  clearArchiveIds: z.array(z.string()).max(20000).optional(),
  updatedAt: z.number().min(0).describe("Client modification time in epoch milliseconds."),
});
export const markerProgressSchema = z
  .object({
    revision: z
      .string()
      .describe("Opaque concurrency token to send as the next mutation baseRevision."),
    markerIndexHash: z.string(),
    updatedAt: z.number().nullable(),
    pointIds: z.array(z.string()),
    retainedPointIds: z
      .array(z.string())
      .describe(
        "Selected point IDs outside the requested manifest. Preserve them when reconciling progress across manifest changes.",
      ),
  })
  .meta({ ref: "MarkerProgress" });
export const archiveProgressSchema = z
  .object({
    revision: z
      .string()
      .describe("Opaque concurrency token to send as the next mutation baseRevision."),
    archiveIndexHash: z.string(),
    updatedAt: z.number().nullable(),
    archiveIds: z.array(z.string()),
  })
  .meta({ ref: "ArchiveProgress" });
export const markerStateResponseSchema = z.object({ progress: markerProgressSchema });
export const archiveStateResponseSchema = z.object({ progress: archiveProgressSchema });
export const markerSyncResponseSchema = z.object({
  ok: z.literal(true),
  unchanged: z.literal(true).optional(),
  progress: markerProgressSchema.extend({
    pointIds: z
      .array(z.string())
      .optional()
      .describe(
        "When absent, the response acknowledges the mutation without returning the full selected set. Read state when a complete set is needed.",
      ),
  }),
});
export const archiveSyncResponseSchema = z.object({
  ok: z.literal(true),
  unchanged: z.literal(true).optional(),
  progress: archiveProgressSchema.extend({
    archiveIds: z
      .array(z.string())
      .optional()
      .describe(
        "When absent, the response acknowledges the mutation without returning the full selected set. Read state when a complete set is needed.",
      ),
  }),
});
export const markerManifestResponseSchema = z.object({
  ok: z.literal(true),
  manifest: z.object({ markerIndexHash: z.string() }),
});
export const archiveManifestResponseSchema = z.object({
  ok: z.literal(true),
  manifest: z.object({ archiveIndexHash: z.string() }),
});
export const progressStatsResponseSchema = z.object({
  markerIndexHash: z.string(),
  pointCount: z.number(),
  totalSyncedUsers: z.number(),
  sampleSize: z.number(),
  counts: z.string().describe("Base64-encoded Uint32 counts in manifest order."),
  updatedAt: z.number().nullable(),
});
