import { expect, it } from "vitest";

import { sha256Hex } from "@/lib/crypto";

import { buildCanonicalMarkerManifest, normalizeManifestPayload } from "./manifest";

it("binds a map fingerprint to point order so bitmap positions cannot be reinterpreted", async () => {
  const pointIds = ["p1", "p2"];
  const markerIndexHash = await sha256Hex(buildCanonicalMarkerManifest(pointIds));
  const manifest = await normalizeManifestPayload({ markerIndexHash, pointIds });
  expect([...manifest.indexById]).toEqual([
    ["p1", 0],
    ["p2", 1],
  ]);
  await expect(
    normalizeManifestPayload({ markerIndexHash, pointIds: ["p2", "p1"] }),
  ).rejects.toMatchObject({ status: 422, code: "PROGRESS_MANIFEST_HASH_MISMATCH" });
});
