import { Redis } from "@upstash/redis";
import type { Bindings } from "../types/app";

export function createRedisClient(env: Bindings): Redis {
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });
}
