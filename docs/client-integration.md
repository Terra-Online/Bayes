# Client integration

Bayes serves the HTTP reference at `/docs` and the generated OpenAPI contract at
`/openapi.json`. The reference defines request fields, response models,
authentication requirements, preconditions, and endpoint-specific recovery.
This guide explains how Atlos and Cor coordinate requests and present results
to users. Use the reference from the backend deployment your client connects to.

`/doc` redirects to `/docs` and follows the same documentation access setting.

## Open the reference

Start the configured local backend with `pnpm dev:local`, then open
`http://127.0.0.1:8787/docs`. The normal local data files and bindings are still
required.

Documentation defaults to enabled when `BETTER_AUTH_URL` names `localhost` or
`127.0.0.1`, and disabled otherwise. Set `API_DOCS_ENABLED=true` or `false` to
override that default. Disabled documentation endpoints return 404. When enabled,
both the reference and specification are readable without a session, including
the descriptions of administrative operations. The operations retain their
normal authentication and role checks.

The local reference allows interactive requests, which execute real operations
against the configured local backend. Outside local development the reference
disables its request controls. This UI setting does not restrict other HTTP
clients. Production documentation remains disabled unless explicitly enabled.
The reference requires access to jsDelivr to load its interactive UI.

To download the running backend's contract and generate TypeScript types for
Atlos or Cor:

```sh
curl --fail http://127.0.0.1:8787/openapi.json -o /tmp/bayes-openapi.json
pnpm exec openapi-typescript /tmp/bayes-openapi.json -o /tmp/bayes-api.d.ts
```

Each client owns its type generation and request implementation. Generated types
describe the wire format; operation and field descriptions explain the guarantees
needed to use it correctly.

Keep exported JSON and generated types as disposable build artifacts. To capture
a particular deployment's contract and cookie scheme, download its `/openapi.json`
when documentation is enabled.

## Browser sessions and account setup

Browser requests use `credentials: "include"`. Configure the frontend origin in
both CORS and trusted origins. Browser code cannot set an HttpOnly session cookie
through Swagger's authorization input; use an existing browser session or a
session bearer token for local request testing.

Registration creates the user and default business fields together. Read the
session response after login. If `needsProfileSetup` is true, update that existing
user's profile. Use the session endpoint for the business user profile rather
than treating the login or registration payload as that profile.

For a browser sign-in flow:

1. Complete login with browser credentials enabled so the browser accepts the
   session cookie.
2. Read the session with `credentials: "include"` before loading account-specific
   state. If the response requests cookie confirmation, let the browser accept
   the replacement cookie and read the session again. Continue when confirmation
   is no longer requested. If it persists, resolve browser cookie acceptance
   before treating sign-in as complete.
3. Complete profile setup when requested, then load the user's contributions,
   progress, and notification state.

When a protected operation returns 401, re-establish the session before retrying.
A 403 requires resolving the operation's permission or origin requirement;
repeated login alone may not resolve it. An anonymous public read can still
succeed after a session expires, so it does not confirm that the user is signed in.

Social login begins in the browser and establishes a proof cookie before the
provider redirect. After callback processing, the frontend exchanges the returned
short-lived code with the same browser proof and trusted origin. Preserve that
browser context throughout the flow. The code alone is insufficient. Keep session
tokens out of callback URLs.

## Progress synchronization

Register the manifest before reading or syncing its state. Marker manifests keep
the supplied index order after trimming IDs, dropping empty IDs, and removing
duplicates. Compute the SHA-256 hex hash of UTF-8 JSON with this exact property
order and compact serialization:

```js
JSON.stringify({ schemaVersion: 1, mapId: "endfield", points: pointIds })
```

Archive manifests require sorted, unique, trimmed IDs. Their canonical JSON is:

```js
JSON.stringify({ schemaVersion: 1, scope: "intel-archives", archives: archiveIds })
```

For example, when a user marks a point complete:

1. Read state for the registered manifest and keep that state alongside any
   unsent local changes.
2. Prepare a mutation against that state's revision with a new mutation ID.
   Keep the complete request until its outcome is known.
3. If the response is lost, resend that same request. Do not change its timestamp,
   revision, or selected IDs while keeping its mutation ID.
4. If the request conflicts with a newer revision, reconcile the user's intended
   changes with the current state supplied by the conflict response, then submit
   a new mutation. Preserve other devices' changes unless the user chooses to
   override them. Re-read state if a complete current view is still needed.
5. Keep the acknowledged revision for subsequent writes. A metadata-only
   acknowledgement does not replace the complete local selected-ID set. A replay
   acknowledges the earlier mutation; another device may have written since then.

Keep retained marker IDs when reconciling manifest changes. Respect the
server's cache headers for aggregate statistics; viewer-specific responses must
remain private.

## Public content and contributions

For a point's content screen, load images and comment trees independently and
show the results that succeeded. A failed or incomplete read must not clear
previously loaded content as though the point had no contributions. Use the
reference's partial-result fields and section errors to identify what to retry.

After submitting content, show that it is awaiting moderation and track it in
the author's contributions. Submission acceptance and visibility to the author
do not establish publication. Keep the public view separate from the author's
view when showing moderation state.

Before editing a comment, load its current context and preserve the approved
snapshot on which the edit is based. If the comment changes before the edit is
accepted, refresh it and let the user reconcile their draft. Do not silently
overwrite a newer version. Reports survive edits and moderation decisions.
Author deletion removes public availability while retaining content and versions.

Comment trees include hidden connector nodes with `type: "placeholder"`. These
nodes carry structure only; show no body, author, reaction, translation, edit, or
reply controls for them. Keep connectors when rendering public descendants.
Honor context truncation when offering navigation to the rest of a discussion.

Do not apply one automatic retry rule to all writes. Progress mutations have
explicit retry identity, while repeated comment votes can toggle the result.
After an uncertain outcome, reconcile the relevant state before repeating a
write whose operation does not promise safe replay.

## Live notification protocol

Connect to the notification WebSocket using the authenticated browser session.
Use a stable `clientId` for one logical connection; a new connection with the same
ID replaces the previous one for that account.

The server sends JSON frames with an `event` discriminator:

- `notification.ready`: contains `unread`, the current unread-count snapshot.
- `notification.upserted`: contains `notification` and `unread`. Upsert the
  notification by ID and replace the unread counts with the supplied snapshot.
  Notification fields use the HTTP notification model from the OpenAPI reference.

Heartbeats are text frames, not JSON. Send an eight-character alphanumeric nonce;
the server echoes it unchanged. `OEMping1` is also an automatic echo heartbeat.
After a missed acknowledgement, use a fresh nonce so a delayed echo cannot
acknowledge a later probe. The text frame `close` requests a normal close.

On disconnect, reconnect with backoff. The ready frame restores badge counts;
refresh the HTTP inbox to reconcile messages missed while disconnected. Live
delivery is an update signal, not a durable replay stream.

## Live position protocol

Complete official account binding and policy agreement first. Obtain a
short-lived socket ticket from the position HTTP endpoint when the WebSocket
client cannot supply session credentials. Tickets are credentials: keep them
short-lived and out of application logs.

Position frames are JSON with a `type` discriminator:

- `status`: `status` is `connecting`, `connected`, or `reconnecting`, with an
  optional human-readable `reason`.
- `position`: `data` follows the position model in the HTTP reference. `binding`
  is included only when requested through the connection query.
- `error`: `error` contains `status`, `code`, `message`, optional `details`, and
  possibly `requestId`. The frame also carries the request ID when available.

The backend can reconnect its upstream while keeping the client connection open.
Treat `reconnecting` as a transient state. Authentication and access checks may
fail after the HTTP upgrade, so handle error frames as well as handshake errors.
If the client connection closes, reconnect with backoff and obtain a fresh ticket
when the previous one expires. Sending the text frame `close` stops the stream.

