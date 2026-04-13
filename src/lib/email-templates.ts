export type EmailLocale = "zh-CN" | "zh-TW" | "en" | "ja" | "ko";

type OtpTemplateType = "sign-in" | "email-verification" | "forget-password";

interface OtpTemplate {
  subject: string;
  title: string;
  intro: string;
  otpLabel: string;
  expiry: string;
  footer: string;
}

interface LinkTemplate {
  subject: string;
  title: string;
  intro: string;
  actionLabel: string;
  fallbackLabel: string;
  footer: string;
}

interface LocaleTemplates {
  otp: Record<OtpTemplateType, OtpTemplate>;
  passwordResetMagicLink: LinkTemplate;
  verifyEmailMagicLink: LinkTemplate;
}

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const OTP_PLACEHOLDER = "{{otp}}";
const EMAIL_TEMPLATES: Record<EmailLocale, LocaleTemplates> = {
  "zh-CN": {
    otp: {
      "sign-in": {
        subject: "[OEM] 验证码：登录终末地地图集",
        title: "登录验证码",
        intro: "你正在登录 Bayes，请输入以下 6 位验证码：",
        otpLabel: "验证码",
        expiry: "验证码 {{otp}} 将在 5 分钟后失效。",
        footer: "如果不是你本人操作，请忽略本邮件。"
      },
      "email-verification": {
        subject: "[OEM] 验证码：注册终末地地图集",
        title: "完成邮箱验证",
        intro: "欢迎注册终末地地图集(Open Endfield Map)，请输入以下 6 位一次性验证码完成邮箱验证：",
        otpLabel: "验证码",
        expiry: "验证码 {{otp}} 将在 5 分钟后失效。",
        footer: "若此封验证码非您本人操作，请忽略本邮件。"
      },
      "forget-password": {
        subject: "[OEM] 验证码：重置密码",
        title: "重置密码验证码",
        intro: "你正在重置 Bayes 密码，请输入以下 6 位验证码：",
        otpLabel: "验证码",
        expiry: "验证码 {{otp}} 将在 5 分钟后失效。",
        footer: "若此封验证码非您本人操作，请忽略本邮件。"
      }
    },
    passwordResetMagicLink: {
      subject: "[OEM] 链接：重置密码",
      title: "重置你的密码",
      intro: "点击下方按钮重置 Bayes 密码：",
      actionLabel: "重置密码",
      fallbackLabel: "如果按钮不可用，请复制以下链接到浏览器：",
      footer: "若此封链接非您本人操作，请忽略本邮件。"
    },
    verifyEmailMagicLink: {
      subject: "[OEM] 链接：验证邮箱",
      title: "验证你的邮箱",
      intro: "点击下方按钮验证你的 Bayes 邮箱：",
      actionLabel: "验证邮箱",
      fallbackLabel: "如果按钮不可用，请复制以下链接到浏览器：",
      footer: "若此封链接非您本人操作，请忽略本邮件。"
    }
  },
  "zh-TW": {
    otp: {
      "sign-in": {
        subject: "[OEM] 驗證碼：登入終末地地圖集",
        title: "登入驗證碼",
        intro: "你正在登入 Open Endfield Map（終末地地圖集），請輸入以下 6 位流动驗證碼：",
        otpLabel: "驗證碼",
        expiry: "驗證碼 {{otp}} 將於 5 分鐘後失效。",
        footer: "若此信件非閣下本人操作，您可以安全地忽略此郵件。"
      },
      "email-verification": {
        subject: "[OEM] 驗證碼：註冊終末地地圖集",
        title: "完成信箱驗證",
        intro: "歡迎註冊 Bayes，請輸入以下 6 位驗證碼完成信箱驗證：",
        otpLabel: "驗證碼",
        expiry: "驗證碼 {{otp}} 將於 5 分鐘後失效。",
        footer: "若此信件非閣下本人操作，您可以安全地忽略此郵件。"
      },
      "forget-password": {
        subject: "[OEM] 驗證碼：重設密碼",
        title: "重設密碼驗證碼",
        intro: "你正在重設 Bayes 密碼，請輸入以下 6 位驗證碼：",
        otpLabel: "驗證碼",
        expiry: "驗證碼 {{otp}} 將於 5 分鐘後失效。",
        footer: "若此信件非閣下本人操作，您可以安全地忽略此郵件。"
      }
    },
    passwordResetMagicLink: {
      subject: "[OEM] 鏈接：重設密碼",
      title: "重設你的密碼",
      intro: "點擊下方按鈕即可重設 Bayes 密碼：",
      actionLabel: "重設密碼",
      fallbackLabel: "若按鈕無法使用，請將以下連結貼到瀏覽器開啟：",
      footer: "若此信件非閣下本人操作，您可以安全地忽略此郵件。"
    },
    verifyEmailMagicLink: {
      subject: "[OEM] 鏈接：驗證信箱",
      title: "驗證你的信箱",
      intro: "點擊下方按鈕即可驗證你的 Bayes 信箱：",
      actionLabel: "驗證信箱",
      fallbackLabel: "若按鈕無法使用，請將以下連結貼到瀏覽器開啟：",
      footer: "若此信件非閣下本人操作，您可以安全地忽略此郵件。"
    }
  },
  en: {
    otp: {
      "sign-in": {
        subject: "[OEM] OTP Code: Sign in to Open Endfield Map",
        title: "Sign-In Verification Code",
        intro: "Use the 6-digit code below to sign in to Bayes:",
        otpLabel: "Verification code",
        expiry: "Code {{otp}} expires in 5 minutes.",
        footer: "If this wasn't you, you can safely ignore this email."
      },
      "email-verification": {
        subject: "[OEM] OTP Code: Verify Email",
        title: "Verify Your Email",
        intro: "Welcome to Open Endfield Map. Use the 6-digit code below to verify your email:",
        otpLabel: "Verification code",
        expiry: "Code {{otp}} expires in 5 minutes.",
        footer: "If this wasn't you, you can safely ignore this email."
      },
      "forget-password": {
        subject: "[OEM] OTP Code: Reset Password",
        title: "Password Reset Verification Code",
        intro: "Use the 6-digit code below to reset your Bayes password:",
        otpLabel: "Verification code",
        expiry: "Code {{otp}} expires in 5 minutes.",
        footer: "If this wasn't you, you can safely ignore this email."
      }
    },
    passwordResetMagicLink: {
      subject: "[OEM] Link: Reset Password",
      title: "Reset Your Password",
      intro: "Click the button below to reset your Bayes password:",
      actionLabel: "Reset password",
      fallbackLabel: "If the button does not work, copy and open this URL in your browser:",
      footer: "If this wasn't you, you can safely ignore this email."
    },
    verifyEmailMagicLink: {
      subject: "[OEM] Link: Verify Email",
      title: "Verify Your Email",
      intro: "Click the button below to verify your Bayes email address:",
      actionLabel: "Verify email",
      fallbackLabel: "If the button does not work, copy and open this URL in your browser:",
      footer: "If this wasn't you, you can safely ignore this email."
    }
  },
  ja: {
    otp: {
      "sign-in": {
        subject: "[OEM] OTP Code: Sign in to Open Endfield Map",
        title: "ログイン認証コード",
        intro: "Bayes にログインするには、以下の 6 桁コードを入力してください。",
        otpLabel: "認証コード",
        expiry: "認証コード {{otp}} の有効期限は 5 分です。",
        footer: "お心当たりがない場合は、このメールを無視してください。"
      },
      "email-verification": {
        subject: "[OEM] OTP Code: Verify Email",
        title: "メールアドレスを認証",
        intro: "Bayes へようこそ。以下の 6 桁コードでメールアドレス認証を完了してください。",
        otpLabel: "認証コード",
        expiry: "認証コード {{otp}} の有効期限は 5 分です。",
        footer: "お心当たりがない場合は、このメールを無視してください。"
      },
      "forget-password": {
        subject: "Bayes パスワード再設定認証コード",
        title: "パスワード再設定認証コード",
        intro: "Bayes のパスワード再設定には、以下の 6 桁コードを入力してください。",
        otpLabel: "認証コード",
        expiry: "認証コード {{otp}} の有効期限は 5 分です。",
        footer: "お心当たりがない場合は、このメールを無視してください。"
      }
    },
    passwordResetMagicLink: {
      subject: "Bayes パスワード再設定リンク",
      title: "パスワードを再設定",
      intro: "下のボタンをクリックして Bayes のパスワードを再設定してください。",
      actionLabel: "パスワードを再設定",
      fallbackLabel: "ボタンが使えない場合は、次の URL をブラウザに貼り付けて開いてください。",
      footer: "お心当たりがない場合は、このメールを無視してください。"
    },
    verifyEmailMagicLink: {
      subject: "Bayes メール認証リンク",
      title: "メールアドレスを認証",
      intro: "下のボタンをクリックして Bayes のメールアドレス認証を完了してください。",
      actionLabel: "メールを認証",
      fallbackLabel: "ボタンが使えない場合は、次の URL をブラウザに貼り付けて開いてください。",
      footer: "お心当たりがない場合は、このメールを無視してください。"
    }
  },
  ko: {
    otp: {
      "sign-in": {
        subject: "Bayes 로그인 인증 코드",
        title: "로그인 인증 코드",
        intro: "Bayes 로그인용 6자리 인증 코드를 입력해 주세요:",
        otpLabel: "인증 코드",
        expiry: "인증 코드 {{otp}} 는 5분 후 만료됩니다.",
        footer: "본인이 요청하지 않았다면 이 메일을 무시해 주세요."
      },
      "email-verification": {
        subject: "Bayes 회원가입 인증 코드",
        title: "이메일 인증 완료",
        intro: "Bayes 회원가입을 완료하려면 아래 6자리 인증 코드를 입력해 주세요:",
        otpLabel: "인증 코드",
        expiry: "인증 코드 {{otp}} 는 5분 후 만료됩니다.",
        footer: "본인이 요청하지 않았다면 이 메일을 무시해 주세요."
      },
      "forget-password": {
        subject: "Bayes 비밀번호 재설정 인증 코드",
        title: "비밀번호 재설정 인증 코드",
        intro: "Bayes 비밀번호를 재설정하려면 아래 6자리 인증 코드를 입력해 주세요:",
        otpLabel: "인증 코드",
        expiry: "인증 코드 {{otp}} 는 5분 후 만료됩니다.",
        footer: "본인이 요청하지 않았다면 이 메일을 무시해 주세요."
      }
    },
    passwordResetMagicLink: {
      subject: "Bayes 비밀번호 재설정 링크",
      title: "비밀번호 재설정",
      intro: "아래 버튼을 눌러 Bayes 비밀번호를 재설정하세요:",
      actionLabel: "비밀번호 재설정",
      fallbackLabel: "버튼이 동작하지 않으면 아래 링크를 브라우저에 붙여넣어 열어 주세요:",
      footer: "본인이 요청하지 않았다면 이 메일을 무시해 주세요."
    },
    verifyEmailMagicLink: {
      subject: "Bayes 이메일 인증 링크",
      title: "이메일 인증",
      intro: "아래 버튼을 눌러 Bayes 이메일 인증을 완료하세요:",
      actionLabel: "이메일 인증",
      fallbackLabel: "버튼이 동작하지 않으면 아래 링크를 브라우저에 붙여넣어 열어 주세요:",
      footer: "본인이 요청하지 않았다면 이 메일을 무시해 주세요."
    }
  }
};

export function resolveEmailLocale(locale: string | undefined): EmailLocale {
  const normalized = locale?.trim().toLowerCase();

  if (!normalized) {
    return "en";
  }

  if (normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")) {
    return "zh-CN";
  }

  if (
    normalized.startsWith("zh-tw") ||
    normalized.startsWith("zh-hant") ||
    normalized.startsWith("zh-hk")
  ) {
    return "zh-TW";
  }

  if (normalized.startsWith("ja")) {
    return "ja";
  }

  if (normalized.startsWith("ko")) {
    return "ko";
  }

  return "en";
}

function fillTemplate(template: string, key: string, value: string) {
  return template.replaceAll(key, value);
}

function renderSimpleHtmlEmail(input: {
  title: string;
  intro: string;
  codeLabel?: string;
  code?: string;
  actionLabel?: string;
  actionUrl?: string;
  fallbackLabel?: string;
  footer: string;
}) {
  const codeBlock =
    input.code && input.codeLabel
      ? `
        <p style="margin: 24px 0 8px; color: #4b5563; font-size: 14px;">${input.codeLabel}</p>
        <p style="margin: 0 0 20px; letter-spacing: 8px; font-size: 32px; font-weight: 700; color: #111827;">${input.code}</p>
      `
      : "";

  const actionBlock =
    input.actionLabel && input.actionUrl
      ? `
        <p style="margin: 24px 0;">
          <a href="${input.actionUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 8px; background: #0f766e; color: #ffffff; text-decoration: none; font-weight: 600;">${input.actionLabel}</a>
        </p>
        <p style="margin: 8px 0; color: #4b5563; font-size: 13px;">${input.fallbackLabel ?? ""}</p>
        <p style="margin: 0 0 16px; color: #0f766e; word-break: break-all;">${input.actionUrl}</p>
      `
      : "";

  return `<!doctype html>
<html lang="en">
  <body style="margin: 0; padding: 0; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding: 24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 640px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 28px;">
            <tr>
              <td>
                <h1 style="margin: 0 0 12px; font-size: 22px; color: #0f172a;">${input.title}</h1>
                <p style="margin: 0 0 8px; color: #334155; font-size: 15px; line-height: 1.6;">${input.intro}</p>
                ${codeBlock}
                ${actionBlock}
                <p style="margin: 16px 0 0; color: #64748b; font-size: 13px; line-height: 1.5;">${input.footer}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function createOtpEmailTemplate(input: {
  locale: EmailLocale;
  type: OtpTemplateType;
  otp: string;
}): RenderedEmail {
  const template = EMAIL_TEMPLATES[input.locale].otp[input.type];
  const expiryText = fillTemplate(template.expiry, OTP_PLACEHOLDER, input.otp);

  return {
    subject: template.subject,
    text: [
      template.title,
      "",
      template.intro,
      `${template.otpLabel}: ${input.otp}`,
      expiryText,
      "",
      template.footer,
    ].join("\n"),
    html: renderSimpleHtmlEmail({
      title: template.title,
      intro: template.intro,
      codeLabel: template.otpLabel,
      code: input.otp,
      footer: `${expiryText} ${template.footer}`,
    }),
  };
}

export function createResetPasswordMagicLinkTemplate(input: {
  locale: EmailLocale;
  url: string;
}): RenderedEmail {
  const template = EMAIL_TEMPLATES[input.locale].passwordResetMagicLink;

  return {
    subject: template.subject,
    text: [
      template.title,
      "",
      template.intro,
      input.url,
      "",
      template.footer,
    ].join("\n"),
    html: renderSimpleHtmlEmail({
      title: template.title,
      intro: template.intro,
      actionLabel: template.actionLabel,
      actionUrl: input.url,
      fallbackLabel: template.fallbackLabel,
      footer: template.footer,
    }),
  };
}

export function createVerifyEmailMagicLinkTemplate(input: {
  locale: EmailLocale;
  url: string;
}): RenderedEmail {
  const template = EMAIL_TEMPLATES[input.locale].verifyEmailMagicLink;

  return {
    subject: template.subject,
    text: [
      template.title,
      "",
      template.intro,
      template.fallbackLabel,
      input.url,
      "",
      template.footer,
    ].join("\n"),
    html: renderSimpleHtmlEmail({
      title: template.title,
      intro: template.intro,
      actionLabel: template.actionLabel,
      actionUrl: input.url,
      fallbackLabel: template.fallbackLabel,
      footer: template.footer,
    }),
  };
}
