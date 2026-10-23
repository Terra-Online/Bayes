import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createImageLifecycleFixture,
  type ImageLifecycleFixture,
} from "@/test/fixtures/imageLifecycle";
import { insertSubmission } from "@/test/fixtures/submissions";

let database: ImageLifecycleFixture["database"];
let moderation: ImageLifecycleFixture["moderation"];
let webhooks: ImageLifecycleFixture["webhooks"];
let request: ImageLifecycleFixture["request"];
let persistedState: ImageLifecycleFixture["persistedState"];
let liveNotifications: ImageLifecycleFixture["liveNotifications"];

beforeEach(() => {
  ({ database, moderation, webhooks, liveNotifications, request, persistedState } =
    createImageLifecycleFixture());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  database.close();
});

function post(id: string, action: string, user = "reader") {
  return request(`/images/${id}/${action}`, user, {});
}

describe("image write permissions", () => {
  it.each(["upvote", "unvote", "flag", "unflag", "recall", "unrecall", "remove-request"])(
    "does not apply image %s to a missing item or a comment",
    async (action) => {
      insertSubmission(database.sqlite, { id: "comment", userId: "author" });
      const before = persistedState();
      for (const id of ["missing", "comment"]) {
        const response = await post(id, action, "author");
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
      }
      expect(persistedState()).toEqual(before);
      expect(webhooks).toEqual([]);
      expect(moderation).toEqual([]);
      expect(liveNotifications).toEqual([]);
    },
  );
});

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: { PublicReadCache: { purgeMarker: async () => ({ success: true }) } },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async zremrangebyscore() {}
    async zcard() {
      return 0;
    }
    async zadd() {}
    async expire() {}
  },
}));
