import type { ApiEnvelope, EndfieldPositionData } from "./types";

const textDecoder = new TextDecoder();

function encodeWebSocketMessage(data: string | ArrayBuffer): string {
  if (typeof data === "string") return data;
  return textDecoder.decode(data);
}

export function parseEndfieldSocketEnvelope(data: string | ArrayBuffer): { type?: number; data?: unknown; msgId?: string } | null {
  const raw = encodeWebSocketMessage(data).trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      data?: unknown;
      msgId?: unknown;
    };
    return {
      type: typeof parsed.type === "number" ? parsed.type : undefined,
      data: parsed.data,
      msgId: typeof parsed.msgId === "string" ? parsed.msgId : undefined
    };
  } catch {
    return null;
  }
}

function normalizePositionData(value: unknown): EndfieldPositionData | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<EndfieldPositionData>;
  const pos = candidate.pos;
  if (
    !pos
    || typeof pos !== "object"
    || typeof (pos as { x?: unknown }).x !== "number"
    || typeof (pos as { y?: unknown }).y !== "number"
    || typeof (pos as { z?: unknown }).z !== "number"
    || typeof candidate.levelId !== "string"
    || typeof candidate.isOnline !== "boolean"
    || typeof candidate.mapId !== "string"
  ) {
    return null;
  }

  return {
    pos: {
      x: (pos as { x: number }).x,
      y: (pos as { y: number }).y,
      z: (pos as { z: number }).z
    },
    levelId: candidate.levelId,
    isOnline: candidate.isOnline,
    mapId: candidate.mapId
  };
}

function findPositionData(value: unknown, depth = 0): EndfieldPositionData | null {
  if (depth > 4 || !value) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      return findPositionData(JSON.parse(trimmed) as unknown, depth + 1);
    } catch {
      return null;
    }
  }

  if (typeof value !== "object") return null;

  const direct = normalizePositionData(value);
  if (direct) return direct;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findPositionData(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["data", "payload", "message", "body", "position"]) {
    const nested = findPositionData(record[key], depth + 1);
    if (nested) return nested;
  }

  return null;
}

export function parseEndfieldPositionSocketMessage(data: string | ArrayBuffer): EndfieldPositionData | null {
  const envelope = parseEndfieldSocketEnvelope(data);
  if (envelope?.type === 1012) {
    return findPositionData(envelope.data);
  }
  return findPositionData(envelope);
}

export function parseEndfieldPositionSocketError(data: string | ArrayBuffer): ApiEnvelope<unknown> | null {
  const envelope = parseEndfieldSocketEnvelope(data);
  if (!envelope?.data || typeof envelope.data !== "object") return null;

  const parsed = envelope.data as Partial<ApiEnvelope<unknown>>;
  return typeof parsed.code === "number" && parsed.code !== 0
      ? {
        code: parsed.code,
        message: parsed.message,
        data: parsed.data
      }
      : null;
}
