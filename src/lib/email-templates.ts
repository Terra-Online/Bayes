import localeTemplates from "./email-template-locales.json";

export type EmailLocale = "zh-HK" | "zh-CN" | "en" | "ja-JP" | "ko-KR" | "de-DE" | "fr-FR" | "es-ES" | "it-IT" | "id-ID" | "pt-BR" | "ru-RU" | "vi-VN" | "th-TH" | "ar-AE" | "hi-IN" | "el-GR" | "ms-MY" | "sv-SE" | "pl-PL";

interface OtpTemplate {
  subject: string;
  title: string;
  intro: string;
  otpLabel: string;
  expires: string;
  ignore: string;
}

interface LinkTemplate {
  subject: string;
  title: string;
  intro: string;
  actionLabel: string;
  fallbackLabel: string;
  expires: string;
  ignore: string;
}

interface FooterLinks {
  siteText: string;
  siteUrl: string;
  blogText: string;
  blogUrl: string;
}

interface LocaleTemplates {
  brand: string;
  links: FooterLinks;
  slogan: string;
  otp: {
    "email-verification"?: OtpTemplate;
  };
  passwordResetMagicLink: LinkTemplate;
}

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const OTP_PLACEHOLDER = "{{otp}}";
const EMAIL_TEMPLATES = localeTemplates as Record<string, LocaleTemplates>;
const SUPPORTED_EMAIL_LOCALES = Object.keys(EMAIL_TEMPLATES) as EmailLocale[];
const EXACT_LOCALE_LOOKUP = new Map<string, EmailLocale>(
  SUPPORTED_EMAIL_LOCALES.map((locale) => [locale.toLowerCase(), locale]),
);

const THEME_COLOR = "#FFC428";
const PAGE_BACKGROUND = "#F2F2EB";
const CODE_CARD_BG = "#F7F7F2";
const TEXT_PRIMARY = "#111111";
const TEXT_MUTED = "#707070";
const FONT_STACK = "-apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif";

const BRAND_ICON_SVG = `
<svg width="92" height="92" viewBox="0 0 92 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path fill="#fff" d="M68.9706,151.7345c1.8721-2.3042,2.3047-6.6245,2.3047-9.5049v-31.1787c0-2.8804-.4326-7.2007-2.3047-9.5049h13.1768c-1.8721,2.3042-2.3037,6.6245-2.3037,9.5049v31.1787c0,2.8615.4293,7.1399,2.2704,9.455l.7894-117.551h-48.7604v3.1157s12.9819,10.2664,13.5015,30.5178v97.623c-.5195,20.2515-13.5015,46.7344-13.5015,46.7344v3.1157h47.5442l.4265-63.5059h-13.1431ZM68.3241,151.7345h-13.1768c1.8721-2.3042,2.3047-6.6245,2.3047-9.5049v-31.1787c0-2.8804-.4326-7.2007-2.3047-9.5049h13.1768c-1.8721,2.3042-2.3037,6.6245-2.3037,9.5049v31.1787c0,2.8804.4316,7.2007,2.3037,9.5049Z"/>
    <path fill="#FBC825" d="M85.2082,142.2297v-31.1787c0-2.8804-.4326-7.2007-2.3047-9.5049h13.1768c-1.8721,2.3042-2.3037,6.6245-2.3037,9.5049v31.1787c0,2.8804.4316,7.2007,2.3037,9.5049h-13.1768c1.8721-2.3042,2.3047-6.6245,2.3047-9.5049Z"/>
    <path fill="#FBC825" d="M99.0314,142.2297v-31.1787c0-2.8804-.4326-7.2007-2.3047-9.5049h13.1768c-1.8721,2.3042-2.3037,6.6245-2.3037,9.5049v31.1787c0,2.8804.4316,7.2007,2.3037,9.5049h-13.1768c1.8721-2.3042,2.3047-6.6245,2.3047-9.5049Z"/>
    <path fill="#FBC825" d="M112.8556,142.2297v-31.1787c0-2.8804-.4326-7.2007-2.3047-9.5049h13.1768c-1.8721,2.3042-2.3037,6.6245-2.3037,9.5049v31.1787c0,2.8804.4316,7.2007,2.3037,9.5049h-13.1768c1.8721-2.3042,2.3047-6.6245,2.3047-9.5049Z"/>
    <path fill="#FBC825" d="M126.6789,142.2297v-31.1787c0-2.8804-.4326-7.2007-2.3047-9.5049h13.1768c-1.8721,2.3042-2.3037,6.6245-2.3037,9.5049v31.1787c0,2.8804.4316,7.2007,2.3037,9.5049h-13.1768c1.8721-2.3042,2.3047-6.6245,2.3047-9.5049Z"/>
    <path fill="#fff" d="M182.0487,215.2404h-47.2534c27.3453-3.166,48.6133-33.7097,55.9967-45.6187h3.1152l-11.8585,45.6187Z"/>
    <path fill="#fff" d="M134.7953,34.1338h47.2534v2.9963l9.9225,39.2178h-3.1152c-3.742-13.4843-21.8209-36.915-54.0607-42.2141Z"/>
</svg>`;

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fillTemplate(template: string, key: string, value: string) {
  return template.replaceAll(key, value);
}

function formatOtpCode(otp: string): string {
  if (/^\d{6}$/.test(otp)) {
    return `${otp.slice(0, 3)}-${otp.slice(3)}`;
  }
  return otp;
}

function renderOemLayout(input: {
  title: string;
  intro: string;
  contentHtml: string;
  expiresText: string;
  ignoreText: string;
  brand: string;
  links: FooterLinks;
  slogan: string;
}): string {
  const safeTitle = escapeHtml(input.title);
  const safeIntro = escapeHtml(input.intro);
  const safeExpires = escapeHtml(input.expiresText);
  const safeIgnore = escapeHtml(input.ignoreText);
  const safeBrand = escapeHtml(input.brand);
  const safeSlogan = escapeHtml(input.slogan);
  const safeSiteText = escapeHtml(input.links.siteText);
  const safeSiteUrl = escapeHtml(input.links.siteUrl);
  const safeBlogText = escapeHtml(input.links.blogText);
  const safeBlogUrl = escapeHtml(input.links.blogUrl);

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:${PAGE_BACKGROUND};font-family:${FONT_STACK};color:${TEXT_PRIMARY};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${PAGE_BACKGROUND};padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:${PAGE_BACKGROUND};border:1px solid #D6D6CD;">
            <tr><td style="height:14px;background:${THEME_COLOR};font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr>
              <td style="padding:34px 28px 30px;">
                <div style="text-align:center;line-height:1;">${BRAND_ICON_SVG}</div>
                <h1 style="margin:18px 0 10px;font-size:46px;line-height:1.2;font-weight:800;text-align:center;">${safeTitle}</h1>
                <p style="margin:0 0 24px;font-size:18px;line-height:1.7;text-align:center;">${safeIntro}</p>
                ${input.contentHtml}
                <p style="margin:28px 0 8px;color:${TEXT_PRIMARY};font-size:15px;line-height:1.75;text-align:center;font-weight:600;">${safeExpires}</p>
                <p style="margin:0 0 0;color:${TEXT_MUTED};font-size:15px;line-height:1.75;text-align:center;">${safeIgnore}</p>
                <div style="text-align:center;margin-top:50px;">
                  <div style="font-size:40px;font-weight:800;line-height:1.15;color:#111;">${safeBrand}</div>
                  <div style="margin-top:6px;font-size:28px;font-weight:700;line-height:1.3;">
                    <a href="${safeSiteUrl}" style="color:#111;text-decoration:none;">${safeSiteText}</a>
                    <span style="color:#d6d6cd;margin:0 8px;">|</span> 
                    <a href="${safeBlogUrl}" style="color:#111;text-decoration:none;">${safeBlogText}</a>
                  </div>
                  <div style="margin-top:10px;font-size:18px;color:#303030;font-style:italic;">${safeSlogan}</div>
                </div>
              </td>
            </tr>
            <tr><td style="height:14px;background:${THEME_COLOR};font-size:0;line-height:0;">&nbsp;</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function resolveEmailLocale(locale: string | undefined): EmailLocale {
  const normalized = locale
    ?.split(",")[0]
    .trim()
    .replaceAll("_", "-")
    .toLowerCase();

  if (!normalized) {
    return "en";
  }

  const exactMatch = EXACT_LOCALE_LOOKUP.get(normalized);
  if (exactMatch) {
    return exactMatch;
  }

  if (normalized.startsWith("zh-hk") || normalized.startsWith("zh-tw") || normalized.startsWith("zh-hant")) {
    return "zh-HK";
  }

  if (normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")) {
    return "zh-CN";
  }

  if (normalized.startsWith("ja")) {
    return "ja-JP";
  }

  if (normalized.startsWith("ko")) {
    return "ko-KR";
  }

  if (normalized.startsWith("de")) {
    return "de-DE";
  }

  if (normalized.startsWith("fr")) {
    return "fr-FR";
  }

  if (normalized.startsWith("es")) {
    return "es-ES";
  }

  if (normalized.startsWith("it")) {
    return "it-IT";
  }

  if (normalized.startsWith("id")) {
    return "id-ID";
  }

  if (normalized.startsWith("pt")) {
    return "pt-BR";
  }

  if (normalized.startsWith("ru")) {
    return "ru-RU";
  }

  if (normalized.startsWith("vi")) {
    return "vi-VN";
  }

  if (normalized.startsWith("th")) {
    return "th-TH";
  }

  if (normalized.startsWith("ar")) {
    return "ar-AE";
  }

  if (normalized.startsWith("hi")) {
    return "hi-IN";
  }

  if (normalized.startsWith("el")) {
    return "el-GR";
  }

  if (normalized.startsWith("ms")) {
    return "ms-MY";
  }

  if (normalized.startsWith("sv")) {
    return "sv-SE";
  }

  if (normalized.startsWith("pl")) {
    return "pl-PL";
  }

  return "en";
}

function getLocaleTemplates(locale: EmailLocale): LocaleTemplates {
  return EMAIL_TEMPLATES[locale] ?? EMAIL_TEMPLATES.en;
}

function getOtpTemplate(localeTemplate: LocaleTemplates): OtpTemplate {
  const fallbackTemplate = EMAIL_TEMPLATES.en.otp["email-verification"];
  const resolvedTemplate = localeTemplate.otp["email-verification"] ?? fallbackTemplate;

  if (!resolvedTemplate) {
    throw new Error("Missing OTP email template configuration.");
  }

  return resolvedTemplate;
}

export function createOtpEmailTemplate(input: {
  locale: EmailLocale;
  otp: string;
}): RenderedEmail {
  const localeTemplate = getLocaleTemplates(input.locale);
  const template = getOtpTemplate(localeTemplate);
  const expiryText = fillTemplate(template.expires, OTP_PLACEHOLDER, input.otp);
  const visualOtp = formatOtpCode(input.otp);

  const codeCardHtml = `
    <div style="display:flex;justify-content:center;margin:8px 0 0;">
      <div style="width:100%;max-width:430px;background:${CODE_CARD_BG};border:1px solid #E3E3DA;border-radius:26px;padding:36px 22px;text-align:center;box-shadow:0 6px 12px rgba(17,17,17,0.08);">
        <div style="font-size:62px;font-weight:700;letter-spacing:4px;line-height:1;color:#4B4B4B;">${escapeHtml(visualOtp)}</div>
      </div>
    </div>
  `;

  return {
    subject: template.subject,
    text: [
      template.title,
      "",
      template.intro,
      `${template.otpLabel}: ${input.otp}`,
      expiryText,
      "",
      template.ignore,
    ].join("\n"),
    html: renderOemLayout({
      title: template.title,
      intro: template.intro,
      contentHtml: codeCardHtml,
      expiresText: expiryText,
      ignoreText: template.ignore,
      brand: localeTemplate.brand,
      links: localeTemplate.links,
      slogan: localeTemplate.slogan,
    }),
  };
}

function createMagicLinkTemplate(
  localeObj: LocaleTemplates,
  template: LinkTemplate,
  url: string
): RenderedEmail {
  const safeUrl = escapeHtml(url);
  const contentHtml = `
    <div style="display:flex;justify-content:center;margin:16px 0 0;">
      <a href="${safeUrl}" style="display:inline-block;background:${THEME_COLOR};color:#1C1C1C;text-decoration:none;padding:14px 24px;border-radius:14px;font-size:18px;font-weight:700;">${escapeHtml(template.actionLabel)}</a>
    </div>
    <p style="margin:22px 0 6px;color:${TEXT_MUTED};font-size:14px;line-height:1.7;">${escapeHtml(template.fallbackLabel)}</p>
    <p style="margin:0;color:#3D3D3D;word-break:break-all;font-size:14px;line-height:1.75;">${safeUrl}</p>
  `;

  return {
    subject: template.subject,
    text: [
      template.title,
      "",
      template.intro,
      template.fallbackLabel,
      url,
      "",
      template.expires,
      template.ignore,
    ].join("\n"),
    html: renderOemLayout({
      title: template.title,
      intro: template.intro,
      contentHtml,
      expiresText: template.expires,
      ignoreText: template.ignore,
      brand: localeObj.brand,
      links: localeObj.links,
      slogan: localeObj.slogan,
    }),
  };
}

export function createResetPasswordMagicLinkTemplate(input: {
  locale: EmailLocale;
  url: string;
}): RenderedEmail {
  const localeObj = getLocaleTemplates(input.locale);
  const template = localeObj.passwordResetMagicLink;
  return createMagicLinkTemplate(localeObj, template, input.url);
}
