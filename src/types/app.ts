import type { oem_imgTrans } from "../services/upload/imageTranscoderContainer";

export type Role = "n" | "p" | "a" | "s" | "r";

export interface Bindings {
  DB: D1Database;
  UGC_BUCKET: R2Bucket;
  OEM_KV?: KVNamespace;
  OEM_USER_DO: DurableObjectNamespace;
  OEM_STATS_DO: DurableObjectNamespace;
  OEM_IMG_TRANS: DurableObjectNamespace<oem_imgTrans>;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  CORS_ORIGINS?: string;
  TRUSTED_ORIGINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_TRANSLATE_CLIENT_EMAIL?: string;
  GOOGLE_TRANSLATE_PRIVATE_KEY?: string;
  GOOGLE_TRANSLATE_PROJECT_ID?: string;
  GOOGLE_TRANSLATE_LOCATION?: string;
  GOOGLE_TRANSLATE_GLOSSARY?: string;
  GOOGLE_TRANSLATE_ALLOWED_LANGUAGES?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_MODERATION_WEBHOOK_URL?: string;
  OPENAI_API_KEY?: string;
  SESSION_TTL_SECONDS?: string;
  PROGRESS_CACHE_TTL_SECONDS?: string;
  UPLOAD_URL_TTL_SECONDS?: string;
  ALLOWED_UPLOAD_MIME?: string;
  MAX_UPLOAD_BYTES?: string;
  UGC_ASSET_BASE_URL?: string;
  UGC_UPLOAD_TEST_PREFIX?: string;
  SKIP_AI_MODERATION?: string;
  LOCAL_UPLOAD_AUTO_APPROVE?: string;
  ENABLE_SCHEDULED_MODERATION?: string;
  SURGE_MODE_ENABLED?: string;
  SURGE_BACKOFF_MULTIPLIER?: string;
  RESEND_AUTH_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_FROM_NAME?: string;
  EMAIL_TEMPLATE_DEFAULT_LOCALE?: string;
  LOCK_PROGRESS_ENDPOINTS?: string;
  LOCK_MODERATION_ENDPOINTS?: string;
  LOCK_UPLOAD_ENDPOINTS?: string;
  LOCK_SCHEDULED_JOBS?: string;
  ENDFIELD_CREDENTIAL_SECRET?: string;
  ENDFIELD_WS_BASE_URL?: string;
}

export interface AuthUser {
  uid: string;
  publicUid: string;
  role: Role;
  karma: number;
  avatar: number;
  email: string;
  nickname: string;
  registeredAt?: string;
  needsProfileSetup: boolean;
}

export interface Variables {
  requestId: string;
  authUser?: AuthUser;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
