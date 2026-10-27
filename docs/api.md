# API guide

This guide maps the current HTTP surface to its implementation. Paths are
relative to the backend origin; use `http://127.0.0.1:8787` for local work.
The mount inventory is [`src/routes/route.ts`](../src/routes/route.ts).
Schemas and co-located HTTP tests define exact validation and response details.

## Common behavior

- Send JSON with `Content-Type: application/json`, except image uploads, which use multipart data.
- Browser requests that use sessions must send `credentials: "include"`.
  Configure both CORS and trusted origins for the frontend origin.
- Authenticated middleware supports session cookies and `Authorization: Bearer <session-token>`.
  Use cookies for the browser flow; do not put long-lived credentials in URLs.
- `x-oem-locale` selects localized email behavior where supported.
- Hono responses expose `x-request-id`. Include it when reporting a failure.
- Authentication does not imply access to every route: moderation and reports
  enforce roles, upload mutations reject suspended users, and feature locks may return `503`.

The shared Hono error handler returns this shape (optional `details` omitted):

```json
{
  "code": "SESSION_REQUIRED",
  "message": "Session is required.",
  "requestId": "example-request-id",
  "error": {
    "code": "SESSION_REQUIRED",
    "message": "Session is required.",
    "requestId": "example-request-id"
  }
}
```

Auth forwarding, Durable Object progress responses, WebSocket setup, and default
not-found responses can use different envelopes. Read `code` and `message`
where present rather than assuming every response contains `error`.

| Status | Typical meaning |
| --- | --- |
| `401` | Missing, invalid, or expired session |
| `403` | Insufficient role, ownership, or origin permission |
| `404` | Resource or route not found |
| `409` | Revision/status conflict, mutation ID reuse, or retention restriction |
| `422` | Invalid input |
| `426` | WebSocket upgrade required |
| `429` | Rate limit exceeded |
| `503` | Feature locked or a required dependency temporarily unavailable |

Read retry headers/details when supplied. Reuse mutation identity on a network
retry only when the request represents the same operation. Respect endpoint
cache headers; private and viewer-specific values must not enter a shared cache.

## Health

| Method | Path | Access and result |
| --- | --- | --- |
| GET | `/` | Public; basic running message |
| GET | `/health/v1/status` | Public; status, service, time, request ID |

Health is an HTTP liveness check. It does not probe every storage/provider binding.
Source: [`health/createRoutes.ts`](../src/routes/health/createRoutes.ts).

## Accounts

All paths in this table are under `/auth/v1`. Public means no existing session
is required; origin, rate-limit, and provider checks still apply.

| Method | Path | Access and purpose |
| --- | --- | --- |
| POST | `/email-otp/send-verification-otp` | Public; registration OTP |
| POST | `/register` | Public; consume OTP and create account with password |
| POST | `/sign-in/email` | Public; email/password sign-in |
| POST | `/sign-in/social` | Public, trusted frontend origin; social sign-in |
| GET, POST, OPTIONS | `/callback/*` | Provider callback forwarding |
| POST | `/session/exchange` | Trusted frontend origin and browser proof; exchange OAuth code |
| GET | `/session` | Resolve session and OEM user profile |
| POST | `/sign-out` | Sign out and expire session cookies |
| PATCH | `/profile` | Session; update nickname/avatar |
| GET | `/list-accounts` | Session; linked account methods |
| POST | `/link-social` | Session; link social provider |
| POST | `/unlink-account` | Session; unlink a login method subject to account rules |
| POST | `/forget-password` | Public; send password-reset link |
| GET | `/reset-password/*` | Password-reset link forwarding |
| GET | `/reset-password-preview` | Public with reset token; inspect reset link |
| POST | `/reset-password` | Public with reset token; set new password |
| GET | `/error` | Auth callback error redirect |

The router explicitly exposes these operations. An installed Better Auth plugin
does not automatically make all of its endpoints public.

### Registration and email login

Send an OTP using a configured development email provider:

```json
{"email":"contributor@example.com","type":"sign-in","locale":"en"}
```

Submit `/register` with the delivered code:

```json
{"email":"contributor@example.com","password":"ExamplePass1!","otp":"123456","name":"Contributor"}
```

Passwords in registration/reset schemas have 8–20 characters, at least one
uppercase letter, and no whitespace. OTPs have six digits. Then read `/session`
to obtain the business user fields, including `needsProfileSetup`.

```js
const response = await fetch("http://127.0.0.1:8787/auth/v1/sign-in/email", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "contributor@example.com", password: "ExamplePass1!" }),
});
```

Forgot-password input uses `email`, `redirectTo`, and optional `locale`.
Reset input uses `token`, `newPassword`, and `repeatPassword`.

### Browser sessions and social login

Production cookie attributes include HttpOnly, Secure, SameSite=None, and
partitioning; localhost uses different attributes. The OAuth flow creates a
browser proof before redirecting to the provider. Callback processing can issue
a short-lived exchange code bound to the frontend origin and proof challenge.
`POST /session/exchange` accepts `{ "code": "..." }` with the matching browser
proof and establishes the browser session. A code alone is not sufficient.

When changing this flow, inspect the frontend caller together with
[`browserSession.ts`](../src/lib/auth/browserSession.ts),
[`socialRoutes.ts`](../src/routes/auth/socialRoutes.ts),
[`oauthCallback/index.ts`](../src/lib/auth/oauthCallback/index.ts), and
[`sessionRoutes.ts`](../src/routes/auth/sessionRoutes.ts).
Do not replace the proof flow with a URL containing a session token.

Sources: [`auth/createRoutes.ts`](../src/routes/auth/createRoutes.ts),
[`schema/auth.ts`](../src/routes/schema/auth.ts), and the auth topic tests.

## Progress

All paths are under `/progress/v1` and require progress to be unlocked.

| Method | Path | Access and purpose |
| --- | --- | --- |
| POST | `/manifest` | Session; register ordered point index and matching hash |
| GET | `/state` | Session; marker state for query `markerIndexHash` |
| POST | `/sync` | Session; apply marker set/clear mutation |
| GET | `/stats` | Public; aggregate statistics for `markerIndexHash` |
| POST | `/archive/manifest` | Session; register archive index |
| GET | `/archive/state` | Session; state for query `archiveIndexHash` |
| POST | `/archive/sync` | Session; apply archive set/clear mutation |

Register a compatible manifest before state/sync operations. Marker manifest
input has `markerIndexHash` and `pointIds`; the hash is the SHA-256 of the
canonical manifest defined in `services/progress/manifest.ts`. Preserve its
index ordering and serialization rules rather than inventing a hash formula.

Marker sync input:

```json
{
  "baseRevision": "",
  "clientMutationId": "example-mutation-1",
  "markerIndexHash": "<registered SHA-256 hash>",
  "setPointIds": ["example-point-id"],
  "clearPointIds": [],
  "updatedAt": 1792627200000
}
```

The example hash and IDs must be replaced with the registered index values.
Use the returned revision as `baseRevision` for later writes; treat it as opaque.
A retry must preserve `clientMutationId` and its payload. A changed payload with
the same mutation ID or a conflicting revision can return `409`.
Public marker state exposes `revision`, `markerIndexHash`, `updatedAt`,
`pointIds`, and `retainedPointIds` rather than requiring the client to decode
stored bitmaps.

Archives use `archiveIndexHash`, `archiveIds`, `setArchiveIds`, and
`clearArchiveIds` under their own manifest contract. Archive state exposes
`revision`, `archiveIndexHash`, `updatedAt`, and `archiveIds`.

Sources: [`progress/createRoutes.ts`](../src/routes/progress/createRoutes.ts),
[`model.ts`](../src/services/progress/model.ts),
[`manifest.ts`](../src/services/progress/manifest.ts),
[`archiveModel.ts`](../src/services/progress/archiveModel.ts),
[`archiveManifest.ts`](../src/services/progress/archiveManifest.ts), and
[`userDo.ts`](../src/services/progress/userDo.ts).

## Images and comments

All paths are under `/uploads/v1`. Public list routes can include viewer data
when a session is supplied; use `publicOnly=1` for the public representation.
Upload and mutation routes require an active user and unlocked uploads unless
otherwise noted.

| Method | Path | Purpose and access |
| --- | --- | --- |
| GET | `/images`, `/comments` | Public marker lists |
| GET | `/images/:id`, `/comments/:id` | Public item reads; `markerId` query required |
| GET | `/images/mine`, `/comments/mine` | Active user; own submissions |
| GET | `/public-file/*` | Public image delivery |
| GET | `/file/*` | Active user; authorized private image delivery |
| POST | `/images` | Multipart image submission |
| POST | `/comments` | JSON comment submission |
| POST | `/comments/translations` | Public with `cachedOnly: true`; otherwise active user required |
| POST | `/images/:id/upvote`, `/images/:id/unvote` | Image reaction |
| POST | `/images/:id/flag`, `/images/:id/unflag` | Image report state |
| POST | `/images/:id/remove-request` | Request image removal |
| POST | `/images/:id/recall`, `/images/:id/unrecall` | Recall or restore image under ownership rules |
| POST | `/comments/:id/upvote`, `/comments/:id/downvote` | Comment reaction |
| POST | `/comments/:id/flag`, `/comments/:id/unflag` | Comment report state |
| POST | `/comments/:id/edit` | Edit comment content |
| POST | `/comments/:id/remove-request`, `/comments/:id/recall` | Comment removal/recall workflow |

Lists accept `markerId` or comma-separated `markerIds`, optional `scope`
(`test` or `prod`), and `limit`. Image limits are 1–24; comment limits are 1–50
with `replyLimit` 0–10. `GET /images?includeMine=1` requires an active user and
cannot be combined with `publicOnly=1`.

```sh
curl 'http://127.0.0.1:8787/uploads/v1/images?markerId=example-point-id&publicOnly=1'
curl 'http://127.0.0.1:8787/uploads/v1/comments?markerId=example-point-id&limit=10&publicOnly=1'
```

Image upload uses `file` (or `image`), `markerId`, `poiHash`, `poiType`, and
optional `content` fields. Let the HTTP client set the multipart boundary.
The handler stores the processed image and returns a pending submission;
acceptance does not mean moderation has finished.

Comment submission requires `markerId`, `poiHash`, `poiType`, and `content`,
with optional `parentId`. Translation input has `commentIds`, `targetLanguage`,
optional `sourceLanguage`, and optional `cachedOnly`.
Partial public reads can include `failedMarkerIds`; retain successful data and
handle the incomplete markers instead of treating the whole result as complete.

Sources: [`uploads/createRoutes.ts`](../src/routes/uploads/createRoutes.ts),
[`schema/uploads.ts`](../src/routes/schema/uploads.ts),
[`comment content contract`](../src/services/upload/contract/commentContent.ts),
and [`publicRead/contract/`](../src/publicRead/contract/).

## Personal contributions

All `/me/v1` routes require a session.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/overview` | OEM user and contribution counts |
| GET | `/contributions` | Cursor-paginated own images/comments |
| GET | `/contributions/:id/preview` | Own image preview, including conditional ETag handling |

Contribution filters are `kind`, `status`, `cursor`, and `limit` (1–50, default
20). Follow the returned cursor rather than building one. Overview/list
responses use private caching for 15 seconds; previews use private caching for
one hour and vary by Cookie/Authorization.

Sources: [`me/createRoutes.ts`](../src/routes/me/createRoutes.ts) and
[`schema/me.ts`](../src/routes/schema/me.ts).

## Notifications

All paths are under `/notify/v1` and require a session.
For category routes, replace `:category` with `system` or `community`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/:category/messages` | List notifications with cursor, limit, optional `unreadOnly` |
| PATCH | `/:category/messages/:id/read` | Mark one notification read |
| POST | `/:category/messages/read` | Mark IDs from `{ "ids": ["..."] }` read |
| POST | `/:category/read-all` | Mark category read |
| GET | `/unread-count` | Unread counts |
| GET (WebSocket) | `/live` | Account-specific live updates; optional `clientId` |

List limits are 1–50, default 20; batch read accepts 1–100 IDs.
Notification HTTP data responses use `private, no-store`.
A plain HTTP request to `/live` returns `426`.
The Worker intercepts real live upgrades before Hono and authenticates and
rate-limits that path separately.

Sources: [`notify/createRoutes.ts`](../src/routes/notify/createRoutes.ts),
[`liveUpgrade.ts`](../src/routes/notify/liveUpgrade.ts), and
[`services/notify/live.ts`](../src/services/notify/live.ts).

## Binding, locator, and official sync

| Method | Full path | Access and purpose |
| --- | --- | --- |
| GET | `/binding/v1/endfield/status` | Session; bound account status |
| POST | `/binding/v1/endfield/exchange-token` | Session; begin token exchange |
| POST | `/binding/v1/endfield/exchange-code` | Session; begin code exchange |
| POST | `/binding/v1/endfield/bind-role` | Session; select/bind role |
| POST | `/binding/v1/endfield/disable` | Session; disable binding |
| POST | `/binding/v1/endfield/unlink` | Session; unlink binding |
| POST | `/locator/agree-policy` | Session; record locator policy agreement |
| GET | `/locator/position` | Authenticated handler; bound account position |
| GET (WebSocket) | `/locator/position-stream` | Bound account stream; socket ticket or session authentication |
| GET | `/sync/v1/official` | Session; retrieve official marks |

Locator routes deliberately do not use a `/v1` prefix. Their handlers perform
identity/ticket resolution even though the position routes precede the shared
`requireAuth` middleware. `position?socket_ticket=1` can provide a short-lived
socket ticket. Follow the binding and policy workflow before requesting position
updates. Do not infer access solely from route mounting order.

Sources: [`schema/binding.ts`](../src/routes/schema/binding.ts),
[`binding/createRoutes.ts`](../src/routes/binding/createRoutes.ts),
[`locator/positionRoutes.ts`](../src/routes/locator/positionRoutes.ts), and
[`sync/createRoutes.ts`](../src/routes/sync/createRoutes.ts).

## Moderation and administrative reports

Moderation paths below are under `/moderation/v1` and require unlocked moderation.
Role `p` is a reviewer, `a` an administrator; `requireRole` treats `r` as administrator.

| Method | Path | Required role |
| --- | --- | --- |
| GET | `/pending` | Reviewer/admin |
| PATCH | `/:id/status` | Reviewer/admin |
| GET | `/images/duplicates`, `/images/duplicates/:markerId` | Reviewer/admin |
| GET | `/images/coverage`, `/images/orphans` | Admin |
| POST | `/warnings` | Admin; sends an email resolved from `publicUid` |
| POST | `/run`, `/run-once` | Admin; selected or queued moderation |
| POST | `/karma/run-once` | Admin; karma evaluation |
| DELETE | `/test-images` | Admin; archive test submissions, retain stored objects |
| DELETE | `/stale` | Admin; returns retention restriction (`409`) |

Warnings accept `{ "publicUid": "..." }`, not a recipient email or display name.
Status transitions can return conflicts and are constrained by the current state.
Content retention is append-only; do not interpret DELETE route names as a
promise of physical data deletion.

Admin report endpoints require an administrator session:

- `GET /admin/v1/reports/registrations`
- `GET /admin/v1/reports/translations`
- `GET /admin/v1/reports/ugc-likes`

Sources: [`moderation/createRoutes.ts`](../src/routes/moderation/createRoutes.ts),
[`schema/moderation.ts`](../src/routes/schema/moderation.ts), and
[`admin-reports/createRoutes.ts`](../src/routes/admin-reports/createRoutes.ts).

## Internal and local entrypoints

`/__demo` is a local/demo helper excluded from the production WAF allowlist;
see [`demo/createRoutes.ts`](../src/routes/demo/createRoutes.ts) for its guards.
`PublicReadCache` and Durable Object endpoints are internal Worker interfaces.
They are not additional public HTTP prefixes.
