import { z } from "zod";

import type { TranslationReport } from "@/repositories/report/translation-report";
import type { UgcLikeReport } from "@/repositories/report/ugc-like-report";
import type { UserRegistrationReport } from "@/repositories/report/user-registration-report";

const dailyCount = z.object({ date: z.string(), count: z.number() });
const languageCount = z.object({ language: z.string(), count: z.number() });
export const registrationReportSchema = z.object({
  generatedAt: z.string(),
  totalUsers: z.number(),
  firstRegistrationDate: z.string().nullable(),
  lastRegistrationDate: z.string().nullable(),
  daily: z.array(dailyCount),
  sources: z.array(z.object({ source: z.string(), count: z.number() })),
}) satisfies z.ZodType<UserRegistrationReport>;
export const translationReportSchema = z.object({
  generatedAt: z.string(),
  totalTranslations: z.number(),
  sourceTexts: z.number(),
  glossaryTranslations: z.number(),
  firstTranslationDate: z.string().nullable(),
  lastTranslationDate: z.string().nullable(),
  daily: z.array(dailyCount),
  sources: z.array(languageCount),
  targets: z.array(languageCount),
  flows: z.array(
    z.object({ sourceLanguage: z.string(), targetLanguage: z.string(), count: z.number() }),
  ),
}) satisfies z.ZodType<TranslationReport>;
export const ugcLikeReportSchema = z.object({
  generatedAt: z.string(),
  totalLikes: z.number(),
  imageLikes: z.number(),
  commentLikes: z.number(),
  commentDislikes: z.number(),
  uniqueReactors: z.number(),
  likedSubmissions: z.number(),
  firstReactionDate: z.string().nullable(),
  lastReactionDate: z.string().nullable(),
  topImage: z
    .object({
      id: z.string(),
      markerId: z.string(),
      poiType: z.string(),
      filePath: z.string(),
      likeCount: z.number(),
      createdAt: z.string(),
      pointUrl: z.string(),
    })
    .nullable(),
  daily: z.array(
    z.object({
      date: z.string(),
      imageLikes: z.number(),
      commentLikes: z.number(),
      commentDislikes: z.number(),
    }),
  ),
  contributorLikes: z.array(z.object({ userId: z.string(), likeCount: z.number() })),
}) satisfies z.ZodType<UgcLikeReport>;
