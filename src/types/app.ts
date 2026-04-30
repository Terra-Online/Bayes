export type Role = "n" | "p" | "a" | "s" | "r";

export interface Bindings {
  DB: D1Database;
  UGC_BUCKET: R2Bucket;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  CORS_ORIGINS?: string;
  TRUSTED_ORIGINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  OPENAI_API_KEY?: string;
  SESSION_TTL_SECONDS?: string;
  PROGRESS_CACHE_TTL_SECONDS?: string;
  UPLOAD_URL_TTL_SECONDS?: string;
  ALLOWED_UPLOAD_MIME?: string;
  MAX_UPLOAD_BYTES?: string;
  RESEND_AUTH_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RESEND_FROM_NAME?: string;
  EMAIL_TEMPLATE_DEFAULT_LOCALE?: string;
  LOCK_PROGRESS_ENDPOINTS?: string;
  LOCK_MODERATION_ENDPOINTS?: string;
  LOCK_UPLOAD_ENDPOINTS?: string;
  LOCK_SCHEDULED_JOBS?: string;
  ENDFIELD_CREDENTIAL_SECRET?: string;
}

export interface AuthUser {
  uid: string;
  publicUid: string;
  role: Role;
  karma: number;
  avatar: number;
  email: string;
  nickname: string;
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
