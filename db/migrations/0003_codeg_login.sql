-- Codeg's profile-only connections are separate from website sessions.
-- Desktop clients are public and return to a loopback address on any port;
-- Web clients are confidential and return to one exact HTTPS address.
CREATE TABLE client_registrations (
  client_id TEXT PRIMARY KEY,
  client_type TEXT NOT NULL CHECK (client_type IN ('desktop', 'web')),
  -- The maintainer of a Web instance. Deleting that account leaves the
  -- registration inactive (see api/clients/routes.ts) until it is reassigned.
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  secret_hash TEXT,
  secret_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((client_type = 'desktop' AND secret_hash IS NULL AND client_id GLOB 'codeg-desktop*' AND redirect_uri GLOB 'http://127.0.0.1/*')
    OR (client_type = 'web' AND secret_hash IS NOT NULL AND client_id GLOB 'codeg-web-*' AND redirect_uri GLOB 'https://*/auth/srn/callback'))
) STRICT;
-- A Web registration is created with a maintainer; only a later account
-- deletion may leave it without one.
CREATE TRIGGER client_registrations_owner BEFORE INSERT ON client_registrations
WHEN NEW.client_type = 'web' AND NEW.owner_user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'web registration requires an owner'); END;
INSERT INTO client_registrations (client_id, client_type, name, redirect_uri, created_at, updated_at)
VALUES ('codeg-desktop', 'desktop', 'Codeg', 'http://127.0.0.1/auth/callback', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE client_login_requests (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES client_registrations(client_id),
  registration_revision INTEGER NOT NULL,
  secret_version INTEGER NOT NULL,
  -- The registration's redirect when the request was made; redirect_uri is
  -- the exact address used (for desktop, with the loopback port).
  registration_redirect_uri TEXT NOT NULL,
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('srn-desktop-code-v1', 'srn-web-code-v1')),
  scope TEXT NOT NULL CHECK (scope = 'profile:read'),
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  challenge_method TEXT NOT NULL CHECK (challenge_method = 'S256'),
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'denied', 'consumed')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT UNIQUE,
  code_expires_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
) STRICT;
CREATE INDEX client_login_requests_expiry ON client_login_requests(expires_at);

CREATE TABLE client_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES client_registrations(client_id),
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('srn-desktop-code-v1', 'srn-web-code-v1')),
  scope TEXT NOT NULL CHECK (scope = 'profile:read'),
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  -- Retained as an immutable one-time uniqueness guard, even after request cleanup.
  source_request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE INDEX client_sessions_user ON client_sessions(user_id, id);
CREATE INDEX client_sessions_expiry ON client_sessions(expires_at);

-- Fixed one-minute windows for authenticated callers only (a signed-in user,
-- a request being decided, a Web client that proved its secret). Anonymous
-- traffic is limited by Workers Rate Limiting bindings, never written here.
CREATE TABLE client_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL
) STRICT;
CREATE INDEX client_rate_limits_window ON client_rate_limits(window_start);
