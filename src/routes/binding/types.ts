import type { Context } from "hono";

import type { AppEnv } from "@/types/app";

export type AppContext = Context<AppEnv>;
