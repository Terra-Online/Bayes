export const POSITION_STREAM_RECONNECT_MS = 1_000;

export function positionReconnectDelay(attempt: number, random = Math.random()): number {
  const ceiling = Math.min(30_000, POSITION_STREAM_RECONNECT_MS * 2 ** Math.min(attempt, 5));
  return Math.round(ceiling * (0.5 + random * 0.5));
}
