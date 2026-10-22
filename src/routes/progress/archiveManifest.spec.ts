import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "@/lib/crypto";
import { buildCanonicalArchiveManifest } from "@/services/progress/archiveManifest";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { createProgressFixture, type ProgressFixture } from "@/test/fixtures/progress";

// Node has no Workers runtime; manifest registration must not call Workers Cache.
vi.mock("cloudflare:workers", () => ({
  exports: {
    get PublicReadCache() {
      throw new Error("Unexpected Workers Cache access during manifest registration");
    },
  },
}));

const HASH_A = "a".repeat(64);

describe("POST /progress/v1/archive/manifest", () => {
  let database: TestDatabase;
  let fixture: ProgressFixture;

  beforeEach(() => {
    database = createTestDatabase();
    // The shared fixture uses real authentication and leaves optional KV absent.
    fixture = createProgressFixture(database);
  });

  afterEach(() => database.close());

  it("accepts the canonical sorted archive manifest", async () => {
    const archiveIds = ["archive-a", "archive-b"];
    // Preserve the existing builder/validator consistency guarantee. This is not
    // an independent external wire-format sample.
    const archiveIndexHash = await sha256Hex(buildCanonicalArchiveManifest(archiveIds));
    const response = await fixture.request(
      new Request("https://progress/archive/manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archiveIndexHash, archiveIds }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      manifest: { archiveIndexHash },
    });
    expect(
      database.sqlite
        .prepare(`SELECT archive_index_hash, archive_ids, archive_count,
          format_version, bits_per_archive FROM archive_progress_manifests
          WHERE archive_index_hash = ?`)
        .get(archiveIndexHash),
    ).toEqual({
      archive_index_hash: archiveIndexHash,
      archive_ids: JSON.stringify(archiveIds),
      archive_count: 2,
      format_version: 1,
      bits_per_archive: 1,
    });
  });

  it.each([
    [["archive-b", "archive-a"], "must be sorted"],
    [["archive-a", "archive-a"], "must not contain duplicate"],
  ])("rejects a non-canonical archive index", async (archiveIds, message) => {
    const response = await fixture.request(
      new Request("https://progress/archive/manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archiveIndexHash: HASH_A, archiveIds }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(message),
    });
    expect(
      database.sqlite
        .prepare("SELECT * FROM archive_progress_manifests WHERE archive_index_hash = ?")
        .get(HASH_A),
    ).toBeUndefined();
  });

  it("rejects a mismatched manifest hash", async () => {
    const response = await fixture.request(
      new Request("https://progress/archive/manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archiveIndexHash: HASH_A, archiveIds: ["archive-a"] }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "ARCHIVE_PROGRESS_MANIFEST_HASH_MISMATCH",
    });
    expect(
      database.sqlite
        .prepare("SELECT * FROM archive_progress_manifests WHERE archive_index_hash = ?")
        .get(HASH_A),
    ).toBeUndefined();
  });
});
