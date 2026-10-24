# Official interactions

This module owns communication on behalf of a user's bound game account.
HTTP handlers keep request parsing, identity extraction, responses, and runtime
scheduling. They call business operations such as `readOfficialMarks`.

- `auth/` owns binding flows, credential decryption and recovery, historical device
  profile repair, and credential cache coordination.
- `client/` implements official request signing, HTTP and socket protocols, response
  decoding, and device registration. It does not access local users or persistence.
- `contract/` contains provider and device-profile definitions shared by the client,
  business code, and repository. Profile codecs are pure; repair policy belongs to auth.
- The binding repository owns queries, row mapping, conditional updates, and atomic
  credential/device-profile writes. Reads do not contact official servers or repair data.

`readBindingCredentials` returns a local credential snapshot, without probing the
upstream. `recoverBindingCredentials` makes a best-effort recovery after an observed
rejection. Recovery may reuse a concurrent winner; it cannot guarantee that the next
upstream operation will accept the credentials. Expired game logins require rebinding.
Failures use exceptions. Business operations decide whether to retry.

Create one credential recovery scope per request or connection, and reuse it for
concurrent recoveries in that lifetime. Only in-flight work is deduplicated; independent
requests must not block each other. Completed credentials use a separate short-lived
cache. Binding changes invalidate both credentials and dependent locator positions.

The official marker lookup remains at `src/routes/binding/officialMarkerHashToPointId.json`
to preserve the owner-provided local data setup.
