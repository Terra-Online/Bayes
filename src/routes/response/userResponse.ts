import type { z } from "zod";

import type { userResponseSchema } from "@/routes/schema/auth";
import type { AuthUser } from "@/types/app";

export function toUserResponse(user: AuthUser): z.output<typeof userResponseSchema> {
  return {
    uid: user.publicUid,
    role: user.role,
    karma: user.karma,
    avatar: user.avatar,
    email: user.email,
    nickname: user.nickname,
    registeredAt: user.registeredAt,
    needsProfileSetup: user.needsProfileSetup,
  };
}
