import { ApiError } from "@/lib/errors";
import type { AppContext } from "@/routes/binding/types";

export function requireUser(c: AppContext) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  return user;
}
