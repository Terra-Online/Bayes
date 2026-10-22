import { describe, expect, it } from "vitest";

import { archiveIdsFromBitmap, type RegisteredArchiveManifest } from "./archiveManifest";
import { emptyArchiveProgressState, type ArchiveProgressState } from "./archiveModel";
import {
  applyArchiveProgressPatch,
  buildArchiveSyncRequestHash,
  normalizeArchiveSyncPatch,
  prepareArchiveProgressForManifest,
} from "./archiveUserProgress";
import { encodeBase64 } from "./bitmap";

const HASH_A = "a".repeat(64);

const manifest = (archiveIndexHash: string, archiveIds: string[]): RegisteredArchiveManifest => ({
  archiveIndexHash,
  formatVersion: 1,
  bitsPerArchive: 1,
  archiveIds,
  archiveCount: archiveIds.length,
  indexById: new Map(archiveIds.map((archiveId, index) => [archiveId, index])),
});

const progress = (
  activeByte: number,
  source: RegisteredArchiveManifest,
  retainedArchiveIds: string[] = [],
): ArchiveProgressState => ({
  version: 1,
  revision: "old-revision",
  marker: encodeBase64(Uint8Array.of(activeByte)),
  checksum: "old-revision",
  archiveIndexHash: source.archiveIndexHash,
  formatVersion: source.formatVersion,
  bitsPerArchive: source.bitsPerArchive,
  archiveCount: source.archiveCount,
  retainedArchiveIds,
  updatedAt: 1,
});

describe("archive progress patches", () => {
  it("deduplicates sync ids and validates metadata", () => {
    const normalized = normalizeArchiveSyncPatch({
      baseRevision: "",
      clientMutationId: "mutation-1",
      archiveIndexHash: HASH_A,
      setArchiveIds: ["archive-a", "archive-a"],
      clearArchiveIds: [],
      updatedAt: 123,
    });
    expect(normalized.setArchiveIds).toEqual(["archive-a"]);
    expect(normalized.updatedAt).toBe(123);
  });

  it("sets and clears known and retained archive ids", () => {
    const target = manifest(HASH_A, ["archive-a", "archive-b"]);
    const patched = applyArchiveProgressPatch(Uint8Array.of(0b01), ["archive-removed"], target, {
      clearArchiveIds: ["archive-a", "archive-removed"],
      setArchiveIds: ["archive-b", "archive-future"],
    });

    expect(archiveIdsFromBitmap(patched.bytes, target)).toEqual(["archive-b"]);
    expect(patched.retainedArchiveIds).toEqual(["archive-future"]);
  });

  it("hashes semantically identical set patches identically", async () => {
    const first = normalizeArchiveSyncPatch({
      clientMutationId: "mutation-1",
      archiveIndexHash: HASH_A,
      setArchiveIds: ["archive-b", "archive-a"],
      updatedAt: 123,
    });
    const second = normalizeArchiveSyncPatch({
      clientMutationId: "mutation-1",
      archiveIndexHash: HASH_A,
      setArchiveIds: ["archive-a", "archive-b"],
      updatedAt: 123,
    });
    await expect(buildArchiveSyncRequestHash(first)).resolves.toBe(
      await buildArchiveSyncRequestHash(second),
    );
  });
});

describe("archive manifest migration", () => {
  it("retains removed collected ids and restores them when they return", async () => {
    const source = manifest("1".repeat(64), ["archive-a", "archive-b"]);
    const reduced = manifest("2".repeat(64), ["archive-b", "archive-c"]);
    const expanded = manifest("3".repeat(64), ["archive-a", "archive-b", "archive-c"]);

    const afterRemoval = await prepareArchiveProgressForManifest(
      progress(0b11, source),
      reduced,
      source,
    );
    expect(archiveIdsFromBitmap(afterRemoval.bytes, reduced)).toEqual(["archive-b"]);
    expect(afterRemoval.retainedArchiveIds).toEqual(["archive-a"]);
    expect(afterRemoval.migrated).toBe(true);

    const afterReturn = await prepareArchiveProgressForManifest(
      { ...afterRemoval.progress, version: 2 },
      expanded,
      reduced,
    );
    expect(archiveIdsFromBitmap(afterReturn.bytes, expanded)).toEqual(["archive-a", "archive-b"]);
    expect(afterReturn.retainedArchiveIds).toEqual([]);
    expect(afterReturn.migrated).toBe(true);
  });

  it("leaves empty progress unchanged", async () => {
    const target = manifest(HASH_A, ["archive-a"]);
    const prepared = await prepareArchiveProgressForManifest(emptyArchiveProgressState(), target);
    expect(prepared.migrated).toBe(false);
    expect(prepared.bytes).toEqual(Uint8Array.of(0));
  });
});
