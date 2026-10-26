import { z } from "zod";

export const providerSchema = z.enum(["skland", "skport"]);
export type EndfieldProvider = z.infer<typeof providerSchema>;
