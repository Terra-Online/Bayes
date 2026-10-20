import localeTemplates from "./templateLocales.json";

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

interface ModerationWarningTemplate {
  subject: string;
  title: string;
  accountLine: string;
  detectedBehavior: string;
  policyIntro: string;
  communityGuidelinesLabel: string;
  communityGuidelinesUrl: string;
  ugcStatementLabel: string;
  ugcStatementUrl: string;
  contextParagraph: string;
  warningParagraph: string;
  appealParagraph: string;
  regards: string;
  signature: string;
  moderationEmail: string;
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
const BRAND_ICON_URL = "https://cdn.opendfieldmap.org/_dev/endfield/atlos/favicon.png";

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
    return otp;
  }
  return otp;
}

function renderOemLayout(input: {
  title: string;
  intro: string;
  contentHtml: string;
  expiresText?: string;
  ignoreText?: string;
  footerPrimaryText?: string;
  footerSecondaryText?: string;
  brand: string;
  links: FooterLinks;
  slogan: string;
}): string {
  const safeTitle = escapeHtml(input.title);
  const safeIntro = escapeHtml(input.intro);
  const safeExpires = escapeHtml(input.footerPrimaryText ?? input.expiresText ?? "");
  const safeIgnore = escapeHtml(input.footerSecondaryText ?? input.ignoreText ?? "");
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
                <div style="text-align:center;line-height:1;">
                  <img
                    src="${BRAND_ICON_URL}"
                    width="92"
                    height="92"
                    alt="${safeBrand}"
                    style="display:inline-block;border:0;outline:none;text-decoration:none;border-radius:20px;"
                  />
                </div>
                <h1 style="margin:18px 0 10px;font-size:32px;line-height:1.2;font-weight:800;text-align:center;">${safeTitle}</h1>
                ${safeIntro ? `<p style="margin:0 0 24px;font-size:18px;line-height:1.7;text-align:center;">${safeIntro}</p>` : ""}
                ${input.contentHtml}
                ${safeExpires ? `<p style="margin:28px 0 8px;color:${TEXT_PRIMARY};font-size:15px;line-height:1.75;text-align:center;font-weight:600;">${safeExpires}</p>` : ""}
                ${safeIgnore ? `<p style="margin:0 0 0;color:${TEXT_MUTED};font-size:15px;line-height:1.75;text-align:center;">${safeIgnore}</p>` : ""}
                <div style="text-align:center;margin-top:50px;">
                  <div style="font-size:24px;font-weight:800;line-height:1.15;color:#111;">${safeBrand}</div>
                  <div style="margin-top:6px;font-size:20px;font-weight:700;line-height:1.3;">
                    <a href="${safeSiteUrl}" style="color:#111;text-decoration:none;">${safeSiteText}</a>
                    <span style="color:#d6d6cd;margin:0 8px;">|</span> 
                    <a href="${safeBlogUrl}" style="color:#111;text-decoration:none;">${safeBlogText}</a>
                  </div>
                  <div style="margin-top:10px;font-size:16px;font-weight: 300;color:#303030;font-style:italic;">${safeSlogan}</div>
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

const MODERATION_WARNING_TEMPLATE: ModerationWarningTemplate = {
  subject: "[OEM Moderation] Warning: Repeated Link-Only Posts",
  title: "Moderation Warning",
  accountLine: "We are contacting you regarding activity associated with your Open Endfield Map account",
  detectedBehavior: "We detected repeated or bulk posting of context-free external links in the discussion area. This is not allowed regardless of Karma level.",
  policyIntro: "Applicable policies:",
  communityGuidelinesLabel: "Community Guidelines",
  communityGuidelinesUrl: "https://blog.opendfieldmap.org/docs/community-guidelines",
  ugcStatementLabel: "UGC Content Statement",
  ugcStatementUrl: "https://blog.opendfieldmap.org/docs/ugc",
  contextParagraph: "Please stop posting link-only comments. Relevant links must include brief context about their purpose or location.",
  warningParagraph: "This is a moderation warning. Further violations may result in account suspension.",
  appealParagraph: "If this notice is incorrect, reply to this email to appeal.",
  regards: "Regards,",
  signature: "OEM Moderation",
  moderationEmail: "moderation@opendfieldmap.org",
};

export function createModerationWarningEmailTemplate(input: {
  displayName: string;
  publicUid: string;
}): RenderedEmail {
  const safePublicUid = escapeHtml(input.publicUid);
  const safeCommunityGuidelinesUrl = escapeHtml(MODERATION_WARNING_TEMPLATE.communityGuidelinesUrl);
  const safeUgcStatementUrl = escapeHtml(MODERATION_WARNING_TEMPLATE.ugcStatementUrl);
  const contentHtml = `
    <div style="margin:8px 0 0;background:${CODE_CARD_BG};border:1px solid #E3E3DA;border-radius:26px;padding:26px 24px;text-align:left;">
      <p style="margin:0 0 18px;font-size:16px;line-height:1.75;">${escapeHtml(MODERATION_WARNING_TEMPLATE.accountLine)} <strong>${safePublicUid}</strong>.</p>
      <p style="margin:0 0 18px;font-size:16px;line-height:1.75;">${escapeHtml(MODERATION_WARNING_TEMPLATE.detectedBehavior)}</p>
      <p style="margin:0 0 8px;font-size:16px;line-height:1.75;">${escapeHtml(MODERATION_WARNING_TEMPLATE.policyIntro)}</p>
      <ul style="margin:0 0 18px;padding-left:24px;font-size:16px;line-height:1.75;">
        <li><a href="${safeCommunityGuidelinesUrl}" style="color:#111;text-decoration:underline;">${escapeHtml(MODERATION_WARNING_TEMPLATE.communityGuidelinesLabel)}</a></li>
        <li><a href="${safeUgcStatementUrl}" style="color:#111;text-decoration:underline;">${escapeHtml(MODERATION_WARNING_TEMPLATE.ugcStatementLabel)}</a></li>
      </ul>
      <p style="margin:0 0 18px;font-size:16px;line-height:1.75;">${escapeHtml(MODERATION_WARNING_TEMPLATE.contextParagraph)}</p>
      <p style="margin:0 0 18px;font-size:16px;line-height:1.75;">${escapeHtml(MODERATION_WARNING_TEMPLATE.warningParagraph)}</p>
      <p style="margin:0 0 18px;font-size:16px;line-height:1.75;">${escapeHtml(MODERATION_WARNING_TEMPLATE.appealParagraph)}</p>
      <p style="margin:0;font-size:16px;line-height:1.75;">${escapeHtml(MODERATION_WARNING_TEMPLATE.regards)}<br><br><strong>${escapeHtml(MODERATION_WARNING_TEMPLATE.signature)}</strong><br>${escapeHtml(MODERATION_WARNING_TEMPLATE.moderationEmail)}</p>
    </div>
  `;

  return {
    subject: MODERATION_WARNING_TEMPLATE.subject,
    text: [
      `Hello ${input.displayName},`,
      "",
      `${MODERATION_WARNING_TEMPLATE.accountLine} ${input.publicUid}.`,
      "",
      MODERATION_WARNING_TEMPLATE.detectedBehavior,
      "",
      MODERATION_WARNING_TEMPLATE.policyIntro,
      `- ${MODERATION_WARNING_TEMPLATE.communityGuidelinesLabel}: ${MODERATION_WARNING_TEMPLATE.communityGuidelinesUrl}`,
      `- ${MODERATION_WARNING_TEMPLATE.ugcStatementLabel}: ${MODERATION_WARNING_TEMPLATE.ugcStatementUrl}`,
      "",
      MODERATION_WARNING_TEMPLATE.contextParagraph,
      "",
      MODERATION_WARNING_TEMPLATE.warningParagraph,
      "",
      MODERATION_WARNING_TEMPLATE.appealParagraph,
      "",
      MODERATION_WARNING_TEMPLATE.regards,
      "",
      MODERATION_WARNING_TEMPLATE.signature,
      MODERATION_WARNING_TEMPLATE.moderationEmail,
    ].join("\n"),
    html: renderOemLayout({
      title: MODERATION_WARNING_TEMPLATE.title,
      intro: `Hello ${input.displayName},`,
      contentHtml,
      brand: "Open Endfield Map",
      links: {
        siteText: "opendfieldmap.org",
        siteUrl: "https://opendfieldmap.org",
        blogText: "Blog",
        blogUrl: "https://blog.opendfieldmap.org",
      },
      slogan: "Omnipresent, Efficient, Meticulous",
    }),
  };
}
