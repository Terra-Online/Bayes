import { describe, expect, it } from "vitest";

import { sha256Hex } from "@/lib/crypto";

import { buildCanonicalArchiveManifest, normalizeArchiveManifestPayload } from "./archiveManifest";

describe("archive manifest canonical index", () => {
  it.each([
    { scenario: "unsorted", archiveIds: ["archive-b", "archive-a"] },
    { scenario: "duplicate", archiveIds: ["archive-a", "archive-a"] },
  ])("rejects a $scenario index even when its fingerprint matches", async ({ archiveIds }) => {
    // A matching fingerprint isolates the canonical-index rule from hash validation.
    const archiveIndexHash = await sha256Hex(buildCanonicalArchiveManifest(archiveIds));
    await expect(
      normalizeArchiveManifestPayload({ archiveIndexHash, archiveIds }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  });

  it("rejects an archive index paired with another index's fingerprint", async () => {
    const archiveIndexHash = await sha256Hex(
      buildCanonicalArchiveManifest(["archive-a", "archive-b"]),
    );
    await expect(
      normalizeArchiveManifestPayload({
        archiveIndexHash,
        archiveIds: ["archive-a", "archive-c"],
      }),
    ).rejects.toMatchObject({ status: 422, code: "ARCHIVE_PROGRESS_MANIFEST_HASH_MISMATCH" });
  });
});
