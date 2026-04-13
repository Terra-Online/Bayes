# 前端认证接口改造报告（Email OTP + 密码找回 Magic Link）

更新时间：2026-04-13

## 1. 改造目标

- 新用户注册：改为邮箱验证码（6 位数字）完成邮箱验证。
- 邮件登录：启用邮箱密码登录。
- 找回密码：保留 Magic Link（邮件里的重置链接）。
- 邮件模板：支持简体中文、繁体中文、英语、日语、韩语，模板与业务代码解耦。

## 2. 后端已完成变更

- 已启用 Better Auth `emailOTP` 插件。
- 邮箱验证改为 OTP（`overrideDefaultEmailVerification: true`）。
- OTP 长度固定 6 位（`otpLength: 6`）。
- 注册后自动触发邮箱 OTP 邮件（`sendVerificationOnSignUp: true` + `emailVerification.sendOnSignUp: true`）。
- 找回密码继续走 Magic Link。
- 兼容端点已开放：
  - `POST /auth/v1/register` -> 转发到 `POST /auth/v1/sign-up/email`
  - `POST /auth/v1/login` -> 转发到 `POST /auth/v1/sign-in/email`

## 3. 前端接口改造清单

### 3.1 注册

请求：`POST /auth/v1/register`

```json
{
  "email": "user@example.com",
  "password": "StrongPass123!",
  "name": "Demo User"
}
```

说明：
- 成功后，后端会自动发送注册验证码邮件（6 位数字）。
- 注册接口成功不代表邮箱已验证，需继续调用 OTP 验证接口。

### 3.2 验证注册邮箱（OTP）

请求：`POST /auth/v1/email-otp/verify-email`

```json
{
  "email": "user@example.com",
  "otp": "123456"
}
```

说明：
- OTP 有效期 5 分钟。
- OTP 输入错误超过限制后需重新申请。

### 3.3 邮箱密码登录

请求：`POST /auth/v1/login`

```json
{
  "email": "user@example.com",
  "password": "StrongPass123!"
}
```

说明：
- 该兼容接口已直接转发到 Better Auth 原生邮箱登录接口。

### 3.4 忘记密码（发送 Magic Link）

请求：`POST /auth/v1/forget-password`

```json
{
  "email": "user@example.com",
  "redirectTo": "https://your-frontend.example.com/reset-password"
}
```

说明：
- 用户收到的是重置密码链接（Magic Link），不是 OTP。
- 用户点击后进入前端重置页，按 Better Auth 规范继续完成密码重置。

### 3.5 读取会话

请求：`GET /auth/v1/get-session`

说明：
- 登录或验证完成后，用于刷新当前用户会话态。

## 4. 前端建议流程（时序）

1. 用户注册：调用 `/auth/v1/register`。
2. 提示用户查收邮箱并输入 6 位验证码。
3. 调用 `/auth/v1/email-otp/verify-email` 完成邮箱验证。
4. 调用 `/auth/v1/get-session` 同步登录态。
5. 忘记密码时，调用 `/auth/v1/forget-password`，引导用户点击邮件链接完成重置。

## 5. 邮件模板与多语言

后端已拆分独立模板配置（与业务逻辑解耦），支持：

- `zh-CN`
- `zh-TW`
- `en`
- `ja`
- `ko`

当前默认语言由环境变量控制：

- `EMAIL_TEMPLATE_DEFAULT_LOCALE`（默认 `en`）

可选配置：

- `RESEND_FROM_EMAIL`（默认 `noreply@opendfieldmap.org`）

## 6. 兼容性与注意事项

- 历史上 `/auth/v1/register` 与 `/auth/v1/login` 返回 410；现在已恢复可用。
- 如果前端直接调用 Better Auth 原生接口，也可继续使用：
  - `/auth/v1/sign-up/email`
  - `/auth/v1/sign-in/email`
- OTP 与 Magic Link 并存：
  - 注册验证邮箱：OTP
  - 忘记密码：Magic Link
