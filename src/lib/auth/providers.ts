import type { Bindings } from "../../types/app";
import { envOrThrow } from "../utils";

function createSocialProviderConfig<TExtra extends Record<string, unknown> = Record<string, never>>(
  env: Bindings,
  clientIdKey: keyof Bindings,
  clientSecretKey: keyof Bindings,
  extra?: TExtra,
): { clientId: string; clientSecret: string } & TExtra {
  return {
    clientId: envOrThrow(env[clientIdKey] as string | undefined, String(clientIdKey)),
    clientSecret: envOrThrow(env[clientSecretKey] as string | undefined, String(clientSecretKey)),
    ...extra,
  } as { clientId: string; clientSecret: string } & TExtra;
}

export function createAuthSocialProviders(env: Bindings): {
  discord: { clientId: string; clientSecret: string; prompt: "consent" };
  github: { clientId: string; clientSecret: string };
  google: { clientId: string; clientSecret: string };
} {
  return {
    google: createSocialProviderConfig(env, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
    discord: createSocialProviderConfig(env, "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", {
      prompt: "consent",
    }),
    github: createSocialProviderConfig(env, "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
  };
}
