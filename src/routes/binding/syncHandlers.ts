import { withAutoRefreshedBinding } from "./credentials";
import { requireUser } from "./helpers";
import { getOfficialMarks, officialMarkedPointIds } from "./officialMarks";
import type { AppContext } from "./types";

export async function handleOfficialMarks(c: AppContext) {
  const user = requireUser(c);
  return withAutoRefreshedBinding(c, user.uid, async (binding) => {
    const result = await getOfficialMarks(binding);
    const markedIds = [...new Set(result.markers
      .filter((marker) => marker.isUserMarked)
      .map((marker) => marker.id))];
    const pointIds = officialMarkedPointIds(markedIds);
    const response = c.json({
      binding: binding.publicBinding,
      timestamp: new Date().toISOString(),
      markedIds,
      pointIds,
      markers: result.markers,
      raw: result.raw
    });
    response.headers.set("cache-control", "private, no-store");
    return response;
  });
}
