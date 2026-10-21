import { z } from "zod";

import { getCommentLength } from "@/services/upload/commentLength";

const COMMENT_MAX_LENGTH = 500;
// A valid nine-character emoji token counts as two units: 250 tokens is the
// longest source that can fit within the submission limit.
const COMMENT_MAX_SOURCE_LENGTH = (COMMENT_MAX_LENGTH / 2) * ":sns_001:".length;
export const commentContentSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (content) =>
      content.length <= COMMENT_MAX_SOURCE_LENGTH &&
      getCommentLength(content) <= COMMENT_MAX_LENGTH,
    { message: "Comment must not exceed 500 characters." },
  );
