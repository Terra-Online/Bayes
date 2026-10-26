import type { SubmissionKind } from "@/repositories/submission/types";
import type { AuthUser, Bindings } from "@/types/app";

export interface UgcActionDependencies {
  bindings: Bindings;
  defer(task: Promise<unknown>): void;
}

export interface UgcActionInput {
  submissionId: string;
  actor: AuthUser;
}

export interface SubmissionActionInput extends UgcActionInput {
  kind: SubmissionKind;
}
