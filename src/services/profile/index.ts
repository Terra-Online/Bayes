import { ApiError } from "@/lib/errors";
import {
  formatPublicUid,
  getErrorMessage,
  getUserByUid,
  saveUserProfile,
} from "@/repositories/users";
import type { Role } from "@/types/app";

import { EDITABLE_NICKNAME_PATTERN } from "./contract/nickname";
import { buildUidSuffixFromNickname } from "./contract/publicUid";

export type UpdateProfileInput = {
  // The caller supplies the authenticated business user's internal ID.
  userId: string;
  nickname: string;
  avatar?: number;
};

export type UpdatedProfile = {
  uid: string;
  role: Role;
  karma: number;
  avatar: number;
  email: string;
  nickname: string;
  registeredAt: string;
  needsProfileSetup: boolean;
};

export async function updateProfile(
  db: D1Database,
  input: UpdateProfileInput,
): Promise<UpdatedProfile> {
  try {
    const current = await getUserByUid(db, input.userId);
    if (!current) {
      throw new Error("USER_NOT_FOUND");
    }

    const nickname = input.nickname.trim();
    if (nickname.length < 2 || nickname.length > 26 || !EDITABLE_NICKNAME_PATTERN.test(nickname)) {
      throw new Error("INVALID_NICKNAME_FORMAT");
    }
    let avatar: number | undefined;
    if (input.avatar !== undefined) {
      avatar = Number.isFinite(input.avatar) ? Math.floor(input.avatar) : Number.NaN;
    }
    if (avatar !== undefined && (!Number.isFinite(avatar) || avatar < 1 || avatar > 99)) {
      throw new Error("INVALID_AVATAR");
    }

    // The first nickname update chooses the public UID suffix. Later updates keep it.
    const uidSuffix = current.nicknameCustomized
      ? current.uidSuffix
      : buildUidSuffixFromNickname(nickname);
    const updated = await saveUserProfile(db, {
      uid: input.userId,
      nickname,
      avatar,
      uidSuffix,
      nicknameCustomized: true,
    });
    if (!updated) {
      throw new Error("USER_NOT_FOUND");
    }
    return {
      uid: formatPublicUid(updated.uidNumber, updated.uidSuffix),
      role: updated.role,
      karma: updated.karma,
      avatar: updated.avt,
      email: updated.email,
      nickname: updated.nickname,
      registeredAt: updated.createdAt,
      needsProfileSetup: !updated.nicknameCustomized,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes("INVALID_NICKNAME_FORMAT")) {
      throw new ApiError(422, "INVALID_NICKNAME_FORMAT", "Nickname format is invalid.");
    }
    if (message.includes("INVALID_AVATAR")) {
      throw new ApiError(422, "INVALID_AVATAR", "Avatar is invalid.");
    }
    if (message.includes("NICKNAME_CONFLICT")) {
      throw new ApiError(409, "NICKNAME_TAKEN", "Nickname is already in use.");
    }
    if (message.includes("USER_NOT_FOUND")) {
      throw new ApiError(404, "USER_NOT_FOUND", "User profile not found.");
    }
    throw new ApiError(500, "PROFILE_UPDATE_FAILED", message);
  }
}
