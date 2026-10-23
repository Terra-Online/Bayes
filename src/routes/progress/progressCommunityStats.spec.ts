import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgressHttpFixture, type ProgressHttpFixture } from "@/test/fixtures/progressHttp";
import type { AppEnv } from "@/types/app";
let fixture: ProgressHttpFixture;
beforeEach(() => {
  fixture = createProgressHttpFixture();
});
afterEach(async () => {
  await fixture.drainStatsDeliveries();
  vi.restoreAllMocks();
  fixture.database.close();
});

describe("progress community stats HTTP", () => {
  it("preserves collections in an unchanged bitmap byte while removing a point in the next byte", async () => {
    const ids = ["p01", "p02", "p03", "p04", "p05", "p06", "p07", "p08", "p09"];
    const hash = await fixture.registerManifest("map", ids);
    const first = await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "across-bytes", { setPointIds: ["p01", "p09"] }),
    );
    await fixture.drainStatsDeliveries();
    await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "remove-last", {
        baseRevision: first.progress.revision,
        clearPointIds: ["p09"],
      }),
    );
    await fixture.drainStatsDeliveries();
    expect(await fixture.readProgress(hash)).toMatchObject({ pointIds: ["p01"] });
    const result = await fixture.readPublicStats(hash);
    expect(result.body).toMatchObject({ pointCount: 9, sampleSize: 1, totalSyncedUsers: 1 });
    expect(result.counts).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("does not cache a failed stats read and recovers on the next public request", async () => {
    const hash = await fixture.registerManifest();
    fixture.statsDelivery = async () =>
      Response.json({ code: "STATS_UNAVAILABLE" }, { status: 503 });
    const failed = await fixture.request(`/stats?markerIndexHash=${hash}`, undefined, null);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
    expect(await failed.json()).toEqual({ code: "STATS_UNAVAILABLE" });
    fixture.statsDelivery = (request, object) => object.fetch(request);
    const recovered = await fixture.readPublicStats(hash);
    expect(recovered.body.sampleSize).toBe(0);
    expect(recovered.response.headers.get("x-oem-kv-cache")).toBe("miss");
  });

  it("returns an empty public sample for a dataset without contributions", async () => {
    const result = await fixture.readPublicStats("a".repeat(64));
    expect(result.body).toEqual({
      markerIndexHash: "a".repeat(64),
      pointCount: 0,
      totalSyncedUsers: 0,
      sampleSize: 0,
      counts: "",
      updatedAt: null,
    });
  });

  it("keeps a permanently rejected stats event and later events for that owner blocked while other owners continue", async () => {
    const hash = await fixture.registerManifest();
    fixture.statsDelivery = async () => new Response("dataset rejected", { status: 409 });
    const first = await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "blocked-event", { setPointIds: ["p1"] }),
    );
    await fixture.drainStatsDeliveries();
    fixture.statsDelivery = (request, object) => object.fetch(request);
    await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "after-blocked", {
        baseRevision: first.progress.revision,
        setPointIds: ["p2"],
      }),
    );
    await fixture.drainStatsDeliveries();
    await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "unaffected-owner", { setPointIds: ["p2"] }, "map", "other"),
    );
    await fixture.drainStatsDeliveries();
    expect(
      fixture.database.sqlite
        .prepare("SELECT mutation_id, status, attempts FROM progress_stats_outbox ORDER BY id")
        .all(),
    ).toEqual([
      { mutation_id: "blocked-event", status: "blocked", attempts: 1 },
      { mutation_id: "after-blocked", status: "pending", attempts: 0 },
      { mutation_id: "unaffected-owner", status: "processed", attempts: 0 },
    ]);
    expect(await fixture.readProgress(hash)).toMatchObject({ pointIds: ["p1", "p2"] });
    const result = await fixture.readPublicStats(hash);
    expect(result.body.sampleSize).toBe(1);
    expect(result.counts).toEqual([0, 1]);
  });

  it("retries a lost stats acknowledgement in order after object recreation without counting a collection twice", async () => {
    const hash = await fixture.registerManifest();
    let loseAcknowledgement = true;
    fixture.statsDelivery = async (request, object) => {
      const response = await object.fetch(request);
      if (new URL(request.url).pathname === "/apply" && loseAcknowledgement) {
        loseAcknowledgement = false;
        return new Response("acknowledgement lost", { status: 503 });
      }
      return response;
    };
    const first = await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "before-offline", { setPointIds: ["p1"] }),
    );
    await fixture.drainStatsDeliveries();
    const eventAwaitingRetry = fixture.database.sqlite
      .prepare("SELECT status, attempts, next_attempt_at FROM progress_stats_outbox")
      .get();
    expect(eventAwaitingRetry).toMatchObject({ status: "retry", attempts: 1 });
    const second = await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "while-offline", {
        baseRevision: first.progress.revision,
        clearPointIds: ["p1"],
        setPointIds: ["p2"],
      }),
    );
    await fixture.drainStatsDeliveries();
    expect(await fixture.readProgress(hash)).toMatchObject({ pointIds: ["p2"] });
    expect(
      fixture.database.sqlite
        .prepare("SELECT mutation_id, status FROM progress_stats_outbox ORDER BY id")
        .all(),
    ).toEqual([
      { mutation_id: "before-offline", status: "retry" },
      { mutation_id: "while-offline", status: "pending" },
    ]);
    // Recreate the stats object with its existing storage so its receipt must
    // prevent the already-applied event from incrementing counts again.
    fixture.stats.clear();
    fixture.users.clear();
    vi.spyOn(Date, "now").mockReturnValue(Number(eventAwaitingRetry!.next_attempt_at) + 1);
    const refresh = await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "back-online", {
        baseRevision: second.progress.revision,
        setPointIds: ["p2"],
      }),
    );
    expect(refresh.unchanged).toBe(true);
    await fixture.drainStatsDeliveries();
    expect(
      fixture.database.sqlite
        .prepare("SELECT mutation_id, status, attempts FROM progress_stats_outbox ORDER BY id")
        .all(),
    ).toEqual([
      { mutation_id: "before-offline", status: "processed", attempts: 1 },
      { mutation_id: "while-offline", status: "processed", attempts: 0 },
    ]);
    const result = await fixture.readPublicStats(hash);
    expect(result.body).toMatchObject({ sampleSize: 1, totalSyncedUsers: 1 });
    expect(result.counts).toEqual([0, 1]);
  });

  it("reports collected point counts and sample size publicly after owners add and clear collections", async () => {
    const hash = await fixture.registerManifest();
    const first = await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "explorer-first", { setPointIds: ["p1"] }),
    );
    await fixture.drainStatsDeliveries();
    await fixture.expectAcceptedSync(
      await fixture.syncProgress(
        hash,
        "other-first",
        { setPointIds: ["p1", "p2"] },
        "map",
        "other",
      ),
    );
    await fixture.drainStatsDeliveries();
    await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "explorer-moved", {
        baseRevision: first.progress.revision,
        clearPointIds: ["p1"],
        setPointIds: ["p2"],
      }),
    );
    await fixture.drainStatsDeliveries();
    const readStatsObject = vi.fn(fixture.statsDelivery);
    fixture.statsDelivery = readStatsObject;
    const result = await fixture.readPublicStats(`%20${hash.toUpperCase()}%20`);
    expect(result.body).toMatchObject({
      markerIndexHash: hash,
      pointCount: 2,
      totalSyncedUsers: 2,
      sampleSize: 2,
    });
    expect(result.counts).toEqual([1, 2]);
    expect(result.response.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
    expect(result.response.headers.get("cloudflare-cdn-cache-control")).toMatch(
      /^public, max-age=\d+$/,
    );
    expect(result.response.headers.get("x-oem-kv-cache")).toBe("miss");
    expect(readStatsObject).toHaveBeenCalledOnce();
    // Repeated public reads must not spend another statistics-object request.
    const cached = await fixture.readPublicStats(hash);
    expect(cached.body).toEqual(result.body);
    expect(cached.response.headers.get("x-oem-kv-cache")).toBe("hit");
    expect(readStatsObject).toHaveBeenCalledOnce();
  });
});

// Cloudflare loopback and WorkerEntrypoint are runtime boundaries. The actual
// cache origin, auth, route, DO, repository and SQL code run without substitution.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: ExecutionContext,
      readonly env: AppEnv["Bindings"],
    ) {}
  },
  exports: { PublicReadCache: { fetch: (request: Request) => fixture.publicCache.fetch(request) } },
}));
