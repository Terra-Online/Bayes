import { z } from "zod";

import { EDITABLE_NICKNAME_PATTERN } from "@/services/profile/contract/nickname";

export const profileUpdateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, "Nickname must be at least 2 characters.")
    .max(26, "Nickname must be 26 characters or fewer.")
    .regex(EDITABLE_NICKNAME_PATTERN, "Nickname can only contain letters, numbers, '_' or '-'."),
  avatar: z.number().int().min(1).max(99).optional(),
  avt: z.number().int().min(1).max(99).optional(),
});
