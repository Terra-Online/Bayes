import type { Redis } from "@upstash/redis";
import { nanoid } from "nanoid";
import { ApiError } from "../lib/errors";

const TICKET_PREFIX = "upload:ticket:";

export interface UploadTicket {
  uid: string;
  markerId: string;
  mimeType: string;
  objectKey: string;
  content: string;
  expiresAt: string;
}

function extensionFromMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

function ticketKey(ticketId: string): string {
  return `${TICKET_PREFIX}${ticketId}`;
}

export async function createUploadTicket(
  redis: Redis,
  payload: {
    uid: string;
    markerId: string;
    mimeType: string;
    content?: string;
  },
  ttlSeconds: number
): Promise<{ ticketId: string; ticket: UploadTicket }> {
  const ticketId = nanoid(32);
  const ext = extensionFromMime(payload.mimeType);
  const objectKey = `ugc/${payload.markerId}/${payload.uid}/${Date.now()}-${nanoid(10)}.${ext}`;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const ticket: UploadTicket = {
    uid: payload.uid,
    markerId: payload.markerId,
    mimeType: payload.mimeType,
    objectKey,
    content: payload.content ?? "",
    expiresAt
  };

  await redis.set(ticketKey(ticketId), JSON.stringify(ticket), { ex: ttlSeconds });
  return { ticketId, ticket };
}

export async function consumeUploadTicket(redis: Redis, ticketId: string): Promise<UploadTicket> {
  const key = ticketKey(ticketId);
  const raw = await redis.get<string>(key);
  if (!raw) {
    throw new ApiError(404, "UPLOAD_TICKET_NOT_FOUND", "Upload ticket not found or expired.");
  }

  await redis.del(key);

  try {
    const parsed = JSON.parse(raw) as UploadTicket;
    if (!parsed.uid || !parsed.markerId || !parsed.mimeType || !parsed.objectKey || !parsed.expiresAt) {
      throw new ApiError(422, "UPLOAD_TICKET_INVALID", "Upload ticket is malformed.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(422, "UPLOAD_TICKET_INVALID", "Upload ticket is malformed.");
  }
}
