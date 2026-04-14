# 前端认证接口改造报告（Email OTP + 密码找回 Magic Link）

更新时间：2026-04-14

## 1. 改造目标

- OTP 全量收敛到 Better Auth 原生框架，不再自建 OTP 存储与校验。
- 注册仍保留 `POST /auth/v1/register`，但请求体改为显式携带 OTP。
- OTP 发送统一走 `type=sign-in`，支持未注册邮箱发码并由 Better Auth 负责一次性消费。
- 保留现有自定义邮件模板与多语言发送能力。
- 找回密码继续走 Magic Link。

## 2. 后端关键行为

- 已启用 Better Auth `emailOTP` 插件并用于注册 OTP 流程。
- OTP 存储改为哈希（非明文），校验由 Better Auth 完成。
- OTP 生成使用密码学随机源，保持 6 位纯数字。
- OTP 验证为逻辑原子：同一个 OTP 不能被并发重复消费。
- OTP 发送增加双限流：IP 维度 + 邮箱维度。

## 3. 前端接口清单

### 3.1 发送注册 OTP

请求：`POST /auth/v1/email-otp/send-verification-otp`

```json
{
  "email": "user@example.com",
  "type": "sign-in",
  "locale": "zh-HK"
}
```

说明：
- 后端会强制按注册流程使用 `type=sign-in`。
- `locale` 可选；也可通过请求头 `x-oem-locale` 传入。

### 3.2 注册（携带 OTP）

请求：`POST /auth/v1/register`

```json
{
  "email": "user@example.com",
  "password": "StrongPass123!",
  "otp": "123456",
  "name": "Demo User"
}
```

说明：
- 顺序由后端编排：先消费 OTP，再创建/登录用户，再设置密码。
- 成功后邮箱视为已验证。

### 3.3 邮箱密码登录

请求：`POST /auth/v1/sign-in/email`

```json
{
  "email": "user@example.com",
  "password": "StrongPass123!"
}
```

说明：
- 旧兼容端点 `/auth/v1/login` 已移除。

### 3.4 忘记密码（发送 Magic Link）

请求：`POST /auth/v1/forget-password`

```json
{
  "email": "user@example.com",
  "redirectTo": "https://your-frontend.example.com/reset-password"
}
```

### 3.5 读取会话（业务增强）

请求：`GET /auth/v1/session`

说明：
- 返回业务增强字段（uid、role、karma、nickname、needsProfileSetup）。

## 4. 前端建议流程（时序）

1. 调用 `/auth/v1/email-otp/send-verification-otp` 发送注册 OTP。
2. 用户输入 6 位验证码。
3. 调用 `/auth/v1/register`（携带 email/password/otp/name）。
4. 调用 `/auth/v1/session` 同步业务态。
5. 忘记密码时，调用 `/auth/v1/forget-password` 并进入重置链接流程。

## 5. 邮件模板与多语言

支持语言包含（不限于）：

- `zh-CN`
- `zh-HK`
- `en`
- `ja`
- `ko`

默认语言：`EMAIL_TEMPLATE_DEFAULT_LOCALE`（默认 `en`）

发件人配置：`RESEND_FROM_EMAIL`

## 6. 兼容性与注意事项

- `/auth/v1/register` 仍保留，但请求体必须带 `otp`。
- `/auth/v1/login` 已下线，请改用 `/auth/v1/sign-in/email`。
- 注册 OTP 路径不再建议使用 `/auth/v1/email-otp/verify-email` 两段式流程。
- OTP 与 Magic Link 并存：
  - 注册：OTP
  - 找回密码：Magic Link

## 7. Atlos 前端对接建议（可直接落地）

### 7.1 推荐 API 封装

```ts
export async function sendRegisterOtp(email: string, locale?: string) {
  return fetch("/auth/v1/email-otp/send-verification-otp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(locale ? { "x-oem-locale": locale } : {}),
    },
    body: JSON.stringify({
      email,
      type: "sign-in",
      ...(locale ? { locale } : {}),
    }),
    credentials: "include",
  });
}

export async function registerWithOtp(input: {
  email: string;
  password: string;
  otp: string;
  name?: string;
}) {
  return fetch("/auth/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    credentials: "include",
  });
}

export async function getBusinessSession() {
  return fetch("/auth/v1/session", {
    method: "GET",
    credentials: "include",
  });
}
```

### 7.2 页面流程建议

1. 用户输入邮箱 -> 显示发送按钮，若点击发送 -> 调用 sendRegisterOtp。
2. 前端禁用发送，显示resend(秒数)，这部分按照目前流程即可；需要存一个localStorage防止通过刷新页面反复发送。
3. 用户输入合法的邮箱、密码 + OTP 校验通过后触发submit行为 -> 调用 registerWithOtp。
4. 注册成功后立即调用 getBusinessSession。
5. 若 `needsProfileSetup=true`，跳转资料补全；否则进入主流程。

### 7.3 错误处理映射（对应到现存的code）

- `INVALID_OTP`：验证码错误，提示重试。
- `TOO_MANY_ATTEMPTS`：验证码尝试次数超限，引导重新发码。
- `RATE_LIMITED`：发送频率超限，读取响应头倒计时后重试。
- `INVALID_EMAIL_OR_PASSWORD`：邮箱密码登录失败。

### 7.4 兼容策略

- 前端统一改为 `POST /auth/v1/sign-in/email`，不再依赖 `/auth/v1/login`。
- 注册流程不再走 `/auth/v1/email-otp/verify-email` 两段式。
