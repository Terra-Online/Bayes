import type { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types/app";
import { applyDefaultSocialCallbackUrls } from "./callbacks";
import type { ForwardToAuthJsonPath } from "./types";

const socialProviderSchema = z.enum(["google", "discord", "github"]);
const linkAccountSchema = z.object({
  provider: socialProviderSchema,
  callbackURL: z.string().optional(),
  errorCallbackURL: z.string().optional(),
  disableRedirect: z.boolean().optional(),
});
const unlinkAccountSchema = z.object({
  provider: z.enum(["email", "google", "discord", "github"]),
});

type AccountRow = {
  providerId: string;
  createdAt: string;
};

function publicProvider(providerId: string): string {
  return providerId === "credential" ? "email" : providerId;
}

export function registerAccountAuthRoutes(
  app: Hono<AppEnv>,
  deps: { forwardToAuthJsonPath: ForwardToAuthJsonPath },
) {
  app.get("/list-accounts", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");

    const result = await c.env.DB.prepare(
      `SELECT providerId, createdAt
       FROM auth_accounts
       WHERE userId = ?1
       ORDER BY createdAt ASC, providerId ASC`,
    ).bind(user.uid).all<AccountRow>();

    const accounts = (result.results ?? []).map((account) => ({
      provider: publicProvider(account.providerId),
      linkedAt: account.createdAt,
      verified: account.providerId === "credential" ? true : undefined,
    }));
    const uniqueProviders = new Set(accounts.map((account) => account.provider));

    const response = c.json({
      accounts: accounts.map((account) => ({
        ...account,
        unlinkable: uniqueProviders.size > 1,
      })),
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });

  app.post("/link-social", requireAuth, rateLimit("auth"), async (c) => {
    const parsed = linkAccountSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid account link payload.", parsed.error.flatten());
    }

    const body = applyDefaultSocialCallbackUrls(c, {
      ...parsed.data,
      disableRedirect: parsed.data.disableRedirect ?? true,
    });
    return deps.forwardToAuthJsonPath(c, "/link-social", body);
  });

  app.post("/unlink-account", requireAuth, rateLimit("auth"), async (c) => {
    const parsed = unlinkAccountSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid account unlink payload.", parsed.error.flatten());
    }

    return deps.forwardToAuthJsonPath(c, "/unlink-account", {
      providerId: parsed.data.provider === "email" ? "credential" : parsed.data.provider,
    });
  });
}
