import type { AuthUser } from "../../types/app";

export function toSessionUser(user: AuthUser) {
  return {
    uid: user.publicUid,
    role: user.role,
    karma: user.karma,
    avatar: user.avatar,
    email: user.email,
    nickname: user.nickname,
    registeredAt: user.registeredAt,
    needsProfileSetup: user.needsProfileSetup
  };
}
