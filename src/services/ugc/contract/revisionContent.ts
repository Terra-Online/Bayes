/** An editorial revision supplies new text or reuses one retained snapshot. */
export type RevisionContent =
  | { type: "text"; content: string }
  | { type: "reuse"; sourceSnapshotId: string };
