import type { Context } from "hono";

import { withAutoRefreshedBinding } from "@/routes/binding/credentials";
import { getOfficialMarks, officialMarkedPointIds } from "@/services/sync/officialMarks";
import type { AppEnv } from "@/types/app";

export async function handleOfficialMarks(c: Context<AppEnv>) {
  const user = c.get("authUser")!;
  return withAutoRefreshedBinding(c, user.uid, async (binding) => {
    const result = await getOfficialMarks(binding);
    const markedIds = [
      ...new Set(result.markers.filter((marker) => marker.isUserMarked).map((marker) => marker.id)),
    ];
    const pointIds = officialMarkedPointIds(markedIds);
    const response = c.json({
      binding: binding.publicBinding,
      timestamp: new Date().toISOString(),
      markedIds,
      pointIds,
      markers: result.markers,
      raw: result.raw,
    });
    response.headers.set("cache-control", "private, no-store");
    return response;
  });
}
