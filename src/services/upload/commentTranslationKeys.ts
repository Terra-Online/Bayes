type CommentTranslationKeyInput = {
  targetLanguage: string;
  glossaryVersion: string;
  textHash: string;
} & (
  | { kind: "translation"; sourceLanguage: string }
  | { kind: "detection" }
);

// Inputs already have normalized languages and the effective glossary version.
// Translation records persist both strings in D1 and KV, so preserve their format.
export function buildCommentTranslationKeys(input: CommentTranslationKeyInput): {
  cacheKey: string;
  flowVersion: string;
} {
  const version = "v1";
  const flowVersion = [
    "translate",
    version,
    input.glossaryVersion,
    "google-v3",
    input.kind === "detection" ? "detect" : input.sourceLanguage,
    input.targetLanguage
  ].join(":");

  return {
    cacheKey: `${flowVersion}:${input.textHash}`,
    flowVersion
  };
}
