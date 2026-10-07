-- Data version 1: users, how they sign in, and their ring numbers.
--
-- Conventions for every table, now and later:
--   * ids are UUIDv7 text (time-ordered; see api/ids.ts), used for every reference;
--   * times are ISO-8601 UTC text, e.g. 2026-10-06T08:00:00.000Z (Better Auth's
--     format on SQLite; it sorts as text);
--   * booleans are 0/1; tables are STRICT, so a wrong type is an error, not data;
--   * names are snake_case.
-- A migration is never edited once applied: change the schema with a new file,
-- and only by adding (new tables, nullable or defaulted columns) until the old
-- code is gone. Apply it with `pnpm db:migrate:remote` before pushing the code
-- that uses it: Cloudflare's build deploys the code but does not migrate.

-- One row per person. `number` is the ring number engraved on the band:
-- 10000 upwards, never reused (see counters).
CREATE TABLE users (
  id             TEXT    PRIMARY KEY,
  number         INTEGER NOT NULL UNIQUE CHECK (number >= 10000),
  name           TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  image          TEXT,
  locale         TEXT    NOT NULL DEFAULT 'en',
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;

-- How a user signs in: one row per provider identity (GitHub, Google; later
-- email codes, passkeys, ...). `account_id` is the provider's own stable id
-- (GitHub's numeric id, Google's `sub`), never an email or a username.
-- Provider tokens are stored encrypted (encryptOAuthTokens).
CREATE TABLE accounts (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id              TEXT NOT NULL,
  account_id               TEXT NOT NULL,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  TEXT,
  refresh_token_expires_at TEXT,
  scope                    TEXT,
  password                 TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (provider_id, account_id)
) STRICT;
CREATE INDEX accounts_user_id ON accounts (user_id);

-- Signed-in browsers; deleting a row signs that browser out.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_user_id ON sessions (user_id);

-- Short-lived values for sign-in flows (OAuth state, later email codes).
CREATE TABLE verifications (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX verifications_identifier ON verifications (identifier);

-- Named sequences. ring_number holds the last number handed out.
CREATE TABLE counters (
  name  TEXT    PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;
INSERT INTO counters (name, value) VALUES ('ring_number', 9999);

-- What happened to an account and when: sign-ins, new users, linked providers.
-- Append-only. The address is a keyed hash (see api/audit.ts), never the IP.
CREATE TABLE audit_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  type       TEXT NOT NULL,
  data       TEXT,
  ip_hash    TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX audit_events_user_id ON audit_events (user_id, created_at);
