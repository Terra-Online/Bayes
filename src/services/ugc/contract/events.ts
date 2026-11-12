/** A reference to an immutable, committed domain fact. It carries no delivery policy. */
export interface UgcEventReference {
  source: "review" | "vote";
  eventId: string;
}
