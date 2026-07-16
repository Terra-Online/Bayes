import type { ApiEnvelope, EndfieldPositionData } from "./types";

const textDecoder = new TextDecoder();

export function isEndfieldCredentialErrorCode(value: unknown): boolean {
  const code = typeof value === "number"
    ? value
    : (typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN);
  return code === 10000 || code === 10002;
}

function normalizeCoordinate(value: unknown, fallback?: number): number | null {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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
    const normalizedType = typeof parsed.type === "number"
      ? parsed.type
      : (typeof parsed.type === "string" && parsed.type.trim() !== "" ? Number(parsed.type) : Number.NaN);
    return {
      type: Number.isFinite(normalizedType) ? normalizedType : undefined,
      data: parsed.data,
      msgId: typeof parsed.msgId === "string" ? parsed.msgId : undefined
    };
  } catch {
    return null;
  }
}

export function normalizeEndfieldPositionData(value: unknown): EndfieldPositionData | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<EndfieldPositionData>;
  const pos = candidate.pos;
  const x = normalizeCoordinate((pos as { x?: unknown } | undefined)?.x);
  const y = normalizeCoordinate((pos as { y?: unknown } | undefined)?.y, 0);
  const z = normalizeCoordinate((pos as { z?: unknown } | undefined)?.z);
  if (
    !pos
    || typeof pos !== "object"
    || x === null
    || y === null
    || z === null
    || typeof candidate.levelId !== "string"
    || typeof candidate.isOnline !== "boolean"
    || typeof candidate.mapId !== "string"
  ) {
    return null;
  }

  return {
    pos: {
      x,
      y,
      z
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

  const direct = normalizeEndfieldPositionData(value);
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

  const parsed = envelope.data as { code?: unknown; message?: string; data?: unknown };
  const code = typeof parsed.code === "number"
    ? parsed.code
    : (typeof parsed.code === "string" && parsed.code.trim() !== "" ? Number(parsed.code) : Number.NaN);
  return Number.isFinite(code) && code !== 0
      ? {
        code,
        message: parsed.message,
        data: parsed.data
      }
      : null;
}
