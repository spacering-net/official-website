# Codeg SRN login operations

This service issues only `profile:read` connections. Website Better Auth sessions
and Codeg credentials remain separate. Production origin is
`https://spacering.net`; no new sign-in provider is needed.

Before deploying changed code, apply `db/migrations/0003_codeg_login.sql` with the
usual D1 migration process. It registers the public `codeg-desktop` client,
whose redirect is a loopback address: `http://127.0.0.1/auth/callback` with any
port from 1024 to 65535 (RFC 8252 section 7.3). Deployment is a separate operation.

## Client registrations

All registrations are manual. `scripts/register-codeg-client.mjs` writes the SQL
(and, for Web, the secret) into a new restricted directory and never touches a
database. Apply its SQL with `wrangler d1 execute DB --remote --file <registration.sql>`.

### Desktop builds

The release build uses `codeg-desktop`. Development and preproduction builds
use their own public client, so their connections are listed apart:

```sh
node scripts/register-codeg-client.mjs --desktop-id codeg-desktop-dev --name "Codeg Dev" --output /secure/codeg-dev
```

Desktop IDs are `codeg-desktop` or `codeg-desktop-<1-24 lowercase letters or
digits>`. Desktop clients send no credentials and always use the loopback
redirect; each build listens on its own port, so builds never take each other's
callbacks.

### Web instances

Verify the maintainer's SRN and control of the proposed hostname before applying
SQL. Require one exclusive hostname per Codeg instance, HTTPS, trusted
certificates, root-path deployment and the standard HTTPS port. Private HTTPS
hostnames are supported when the browser can reach them. Sharing a hostname
across ports or proxy paths is unsupported. SRN never fetches the instance's
private network.

```sh
node scripts/register-codeg-client.mjs --owner-srn 10000 --public-url https://codeg.example.com --output /secure/codeg-registration
```

The script creates `registration.sql` (hash only) and `client-secret` (mode 0600),
and prints only paths and the public client ID. The database refuses a Web
registration whose owner SRN does not exist. Deliver the secret file privately
to that instance operator. Configure Codeg:

```text
CODEG_PUBLIC_URL=https://codeg.example.com
CODEG_SRN_CLIENT_ID=codeg-web-<generated ID>
CODEG_SRN_CLIENT_SECRET_FILE=/run/secrets/codeg-srn-client-secret
```

Keep that file out of inherited agent environments, archives, backups, exports,
frontend assets and logs. Never put its contents in command-line arguments.
The registered exact redirect is `<CODEG_PUBLIC_URL>/auth/srn/callback`.
The first version offers neither anonymous registration nor a developer portal.

Routine rotation: run the script with `--rotate-client-id <ID> --output <new
directory>`, coordinate the new file with the operator, then apply its SQL and
check that it changed one row. There is no grace period: the old secret and its
pending requests/codes fail immediately. Existing profile connections remain
valid. If compromise is suspected, disable the registration and revoke its
connections instead:

```sql
UPDATE client_registrations SET enabled = 0,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE client_id = '<verified ID>';
UPDATE client_sessions SET revoked_at = COALESCE(revoked_at,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE client_id = '<verified ID>';
```

Changing a callback requires re-verifying hostname control, changing
`redirect_uri` and incrementing `revision` in the same update. Disabling a client
blocks new grants and new Bearer authentication, including renewal. Turning it
back on without revoking sessions restores unexpired existing connections, so
use bulk revocation when permanent disconnection is intended.

Deleting the maintainer's SRN account clears `owner_user_id`. An ownerless Web
registration is inactive, exactly like a disabled one, until an operator
assigns a verified new maintainer (`UPDATE client_registrations SET
owner_user_id = ...`). Revoke its connections if it should not come back.

## Wire protocol

All request bodies are flat JSON. Unknown or duplicate names are rejected.
Dates are ISO-8601 UTC strings. Errors are `{ "error": "snake_case" }`.
Request IDs, codes and tokens never appear in a URL that SRN receives.

- `POST /api/client/v1/login-requests`: `client_id`, `redirect_uri`,
  `response_type: "code"`, `scope: "profile:read"`, random `state`,
  `code_challenge`, `code_challenge_method: "S256"`, random `installation_id`,
  `platform`, optional `device_name`. Returns `request_id`, `authorization_url`
  (`https://spacering.net/authorize/#request_id=...`: the fragment never
  reaches a server) and `expires_at` (ten minutes).
- `POST /api/client/v1/login-requests/lookup`: `{ request_id }`. Public
  presentation only: `client: { name, type, origin }`, `scope`, `status`,
  `expires_at`.
- `POST /api/client/v1/login-requests/decision`: website cookie, exact SRN
  Origin, JSON `request_id`, `decision: "approve" | "deny"`, `expected_srn`
  number. Only a successful decision returns `callback_url`. Cross-tab account
  changes return `account_changed`, requiring account display and reconfirmation.
- `POST /api/client/v1/token`: `grant_type: "authorization_code"`, `client_id`,
  exact `redirect_uri` (for desktop, the same port as the request), `code`,
  `code_verifier`. Returns `access_token`, `token_type: "Bearer"`, `scope`,
  `expires_at`, `connection_id`, `user: { srn, name, image }`. A wrong verifier
  or redirect does not consume the code. A code presented again with its
  verifier revokes the connection it issued (RFC 6749 section 4.1.2), so
  clients must not retry an exchange whose answer was lost: start again.
- `GET /api/client/v1/me`: dedicated Bearer only; returns `scope`, `expires_at`,
  `connection_id`, `user`. Revocation and expiry are checked against D1 every
  time; use is recorded at most hourly, and the connection renewed at most daily
  to thirty days of inactivity.
- `POST /api/client/v1/logout`: dedicated Bearer only; idempotent `{ ok: true }`.
- `GET /api/me/clients`, `DELETE /api/me/clients/:id`: website cookie only;
  ownership limits every query/write. Lists include authoritative `account_srn`;
  the dialog compares it with the displayed account before rendering rows.
  Each connection has `status` (`active`, `expired`, `revoked`, or `disabled`
  when its registration is disabled or ownerless) and, for Web, `client_origin`,
  the instance holding it. DELETE requires exact SRN Origin and JSON
  `{ expected_srn: <displayed SRN> }`. A changed browser account returns
  `account_changed`, requiring redisplay and a new confirmation. Disabled
  registrations can still be revoked. Lists return at most 100 rows and
  `next_cursor`; pass it as `?cursor=...` to see older connections.

The authorization page asks the signed-in account for an explicit approval.
For a Web instance it also shows the instance's address from the lookup, the
person's only way to see which server is asking: its host in full, never
shortened (the whole origin when it is not HTTPS on the standard port). A
desktop request shows no address.

The authorization page reads the request ID from the fragment and removes it
from the address bar before making requests. A short-lived request reference and
a fixed local tab retention deadline live only in that tab's sessionStorage,
including across the provider roundtrip and language changes. Provider
callback/error URLs are fixed page paths without request IDs. Completed/expired
requests clear the tab reference. Temporary rate limits/server failures preserve
it and offer an explicit refresh. The local retention deadline starts at first
entry and is never extended by refresh, language switching or provider return.
Server expiry is authoritative and is never compared with the browser clock.

Web request creation and exchange additionally require RFC 6749
`client_secret_basic`; the body ID must match the authenticated client.
Desktop requests have no embedded secret. Native routes reject cookie mixing.
Website routes reject client Bearer. A client token cannot authorize arbitrary
website or Codeg workspace APIs.

## Rate limits

- Every client route and the connection list: `CLIENT_LIMIT`, 300 a minute
  per address (a Workers Rate Limiting binding; no database write).
- Anonymous steps, per address and step: `CLIENT_FLOW_LIMIT`, 20 a minute for
  desktop request creation, page lookup and desktop code exchange.
- After authentication, in D1 (`client_rate_limits`): a Web client's request
  creation and code exchange, 60 a minute each per client (its users share the
  instance's address); decisions, 20 a minute per signed-in user and 10 per request.

Workers Rate Limiting counts per Cloudflare location; the D1 windows are shared.
Before launch, check that Cloudflare bot protection does not challenge
`/api/client/v1/*`: Codeg calls it from Rust, not a browser.

## Verification and observability

`pnpm test` includes actual workerd/Miniflare D1 integration, validating the
migration (including its trigger), batch rollback, no-op writes, concurrent
decisions, a single concurrent exchange and the revocation that follows reuse.
The Node SQLite harness separately covers PKCE failure, loopback rules, client
kinds, bindings, owner limits, Origin, account change, rotation, disabling,
owner deletion, expiry and limits. `pnpm check` and `pnpm build` validate both
site and Worker bundles; `scripts/qa-codeg-login.mjs` drives the built pages.

No request/response bodies, Authorization, cookies or SQL binds may be added to
application logs. Invocation logs stay on: request IDs live only in fragments
and bodies, and codes only in bodies and the client's own callback. Codeg
reverse proxies must omit the `/auth/srn/callback` query from access logs.
Responses and authorization pages use no-store/no-referrer/nosniff/
frame-ancestors protection; the authorization UI loads scripts locally. Both
authorization pages are rendered by the Worker, and the Worker rejects
non-entry aliases of them; there is no authorization HTML in static assets.
Hourly/daily cleanup uses the existing scheduled task.

Local automated checks do not replace preproduction GitHub/Google, real loopback
delivery across supported operating systems, browser and TLS proxy validation.
