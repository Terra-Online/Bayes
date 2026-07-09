import type { Bindings } from "../../types/app";
import { resolveEmailLocale } from "../email/templates";

const OEM_LOCALE_HEADER = "x-oem-locale";

function pickLocaleFromUser(user: unknown): string | undefined {
  if (!user || typeof user !== "object") {
    return undefined;
  }

  const locale = (user as Record<string, unknown>).locale;
  return typeof locale === "string" && locale.trim().length > 0 ? locale : undefined;
}

function pickLocaleFromRequest(request: Request | undefined): string | undefined {
  if (!request) {
    return undefined;
  }

  const localeHeader = request.headers.get(OEM_LOCALE_HEADER)?.trim();
  if (localeHeader) {
    return localeHeader;
  }

  const acceptLanguage = request.headers.get("accept-language")?.trim();
  return acceptLanguage || undefined;
}

export function pickRequestFromCtx(ctx: unknown): Request | undefined {
  if (!ctx || typeof ctx !== "object") {
    return undefined;
  }

  const maybeRequest = (ctx as { request?: unknown }).request;
  return maybeRequest instanceof Request ? maybeRequest : undefined;
}

export function resolvePreferredEmailLocale(
  env: Bindings,
  user: unknown,
  request?: Request,
): ReturnType<typeof resolveEmailLocale> {
  const fromRequest = pickLocaleFromRequest(request);
  const fromUser = pickLocaleFromUser(user);
  return resolveEmailLocale(fromRequest ?? fromUser ?? env.EMAIL_TEMPLATE_DEFAULT_LOCALE);
}
