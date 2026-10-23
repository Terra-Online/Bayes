import { afterEach, describe, expect, it } from "vitest";

import { createMockBindings, type MockBindings } from "./bindings";
import { SqliteD1 } from "./database/sqliteD1";

const databases: SqliteD1[] = [];
function setup(): MockBindings {
  const database = new SqliteD1();
  databases.push(database);
  return createMockBindings({ DB: database.db });
}
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("mock bindings", () => {
  it("keeps configured results and recorded calls local to each environment", async () => {
    const first = setup();
    const second = setup();
    first.autoModerationQueue.send.mockResolvedValue({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
    });
    await first.bindings.OEM_AUTO_MODERATION_Q.send({
      type: "moderation",
      submissionId: "image-1",
      snapshotId: "snapshot-1",
      source: "upload",
      queuedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(first.autoModerationQueue.send).toHaveBeenCalledOnce();
    expect(second.autoModerationQueue.send).not.toHaveBeenCalled();
    expect(() =>
      second.bindings.OEM_AUTO_MODERATION_Q.send({
        type: "moderation",
        submissionId: "image-2",
        snapshotId: "snapshot-2",
        source: "upload",
        queuedAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow("Unconfigured mock binding: OEM_AUTO_MODERATION_Q.send");
  });

  it("reports unconfigured external operations instead of returning successful empty results", () => {
    const mocks = setup();
    expect(() => mocks.bindings.UGC_BUCKET.get("missing.webp")).toThrow(
      "Unconfigured mock binding: UGC_BUCKET.get",
    );
    expect(() => mocks.bindings.OEM_TRANSLATION_Q.sendBatch([])).toThrow(
      "Unconfigured mock binding: OEM_TRANSLATION_Q.sendBatch",
    );
    expect(() => mocks.bindings.OEM_AUTH_RATE_LIMIT.limit({ key: "user-1" })).toThrow(
      "Unconfigured mock binding: OEM_AUTH_RATE_LIMIT.limit",
    );
    expect(() => mocks.bindings.OEM_NOTIFICATION_DO.getByName("user-1")).toThrow(
      "Unconfigured mock binding: OEM_NOTIFICATION_DO.getByName",
    );
  });

  it("allows async SDK lookup of the transcoder without treating the stub as a promise", async () => {
    const mocks = setup();
    const transcoder = await Promise.resolve(mocks.imageTranscoder);
    mocks.imageTranscoder.fetch.mockResolvedValue(new Response("prepared"));
    expect(await (await transcoder.fetch("http://transcoder/prepare")).text()).toBe("prepared");
    expect(() => transcoder.getState()).toThrow(
      "Unconfigured mock binding: OEM_IMG_TRANS.getState",
    );
    expect(transcoder.getState).toHaveBeenCalledOnce();
  });

  it("fails when reading an unconfigured RPC property, just as for an unconfigured method", async () => {
    const mocks = setup();
    await expect(Promise.resolve(mocks.imageTranscoder.defaultPort)).rejects.toThrow(
      "Unconfigured mock binding: OEM_IMG_TRANS.defaultPort",
    );
  });
});
