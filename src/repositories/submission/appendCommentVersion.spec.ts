import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { applyMigrations, migrations } from "@/test/database/migrations";
import { SqliteD1 } from "@/test/database/sqliteD1";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";
import { insertUser } from "@/test/fixtures/users";

import { appendCommentVersion } from "./appendCommentVersion";

it("serializes competing connections, rolls back failed appends and never consumes a revision for losers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "comment-edit-"));
  const first = new SqliteD1(join(directory, "db.sqlite"));
  const second = new SqliteD1(join(directory, "db.sqlite"));
  try {
    applyMigrations(first.sqlite, migrations);
    insertUser(first.sqlite, { uid: "author" });
    importCurrentSubmissions(first);
    insertCommentSnapshot(first.sqlite, { id: "comment", userId: "author", snapshotId: "A" });
    const input = {
      submissionId: "comment",
      parentSnapshotId: "A",
      actorId: "author",
      content: "Changed",
    };
    await expect(
      appendCommentVersion(first.db, { ...input, snapshotId: "invalid", content: "  " }),
    ).rejects.toThrow();
    const results = await Promise.all([
      appendCommentVersion(first.db, { ...input, snapshotId: "B" }),
      appendCommentVersion(second.db, { ...input, snapshotId: "C" }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["appended", "conflict"]);
    expect(first.sqlite.prepare("SELECT revision FROM ugc_submissions").all()).toEqual([
      { revision: 2 },
    ]);
    expect(
      first.sqlite.prepare("SELECT revision FROM ugc_snapshots ORDER BY revision").all(),
    ).toEqual([{ revision: 1 }, { revision: 2 }]);
    // Role is checked in the batch, independently of any stale caller identity.
    first.sqlite.exec("UPDATE ugc_snapshots SET review_status='approved' WHERE revision=2");
    insertUser(first.sqlite, { uid: "former-admin", role: "n" });
    const frontier = first.sqlite.prepare("SELECT id FROM ugc_snapshots WHERE revision=2").get()!;
    expect(
      await appendCommentVersion(second.db, {
        ...input,
        actorId: "former-admin",
        parentSnapshotId: String(frontier.id),
        snapshotId: "D",
      }),
    ).toEqual({ outcome: "unauthorized" });
  } finally {
    second.close();
    first.close();
    rmSync(directory, { recursive: true });
  }
});
