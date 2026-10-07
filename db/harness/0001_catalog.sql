-- Harness data version 1: the catalog. Publishers, items and their versions,
-- the search index, tags, import sources and the checks' rules.
--
-- This is the `harness` database, apart from the accounts in `spacering`
-- (wrangler.jsonc says why). It follows the same conventions (see
-- db/migrations/0001_users.sql): UUIDv7 text ids, ISO-8601 UTC times as text,
-- 0/1 booleans, STRICT tables, snake_case, and migrations that only add.
-- There are no references across the two databases: a `user_id` here is just
-- text. Apply with `pnpm db:migrate:remote`, before pushing code that needs it.

-- Who an item is published under. The handle is the address,
-- /harness/<handle>/<name>; publishers are known by their stable ids (an SRN
-- user, GitHub's numeric id, a domain), so a GitHub rename changes nothing.
--   kind 'github': imported under a GitHub account (registry namespaces
--     io.github.<login>, skill repositories); unclaimed until its owner signs in.
--   kind 'domain': a registry namespace like com.example, as example.com. Only
--     these handles contain dots.
--   kind 'user': an SRN user who chose a handle (H2).
-- `bulk`: publishes in bulk; its imports stay listed (not on the shelves)
-- unless `bulk_exempt` says a person looked and vouched for them.
CREATE TABLE publishers (
  id           TEXT    PRIMARY KEY,
  handle       TEXT    NOT NULL UNIQUE,
  kind         TEXT    NOT NULL CHECK (kind IN ('github', 'domain', 'user')),
  user_id      TEXT,
  github_id    INTEGER UNIQUE,
  github_login TEXT,
  domain       TEXT    UNIQUE,
  name         TEXT    NOT NULL,
  avatar       TEXT,
  verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  bulk         INTEGER NOT NULL DEFAULT 0 CHECK (bulk IN (0, 1)),
  bulk_exempt  INTEGER NOT NULL DEFAULT 0 CHECK (bulk_exempt IN (0, 1)),
  show_number  INTEGER NOT NULL DEFAULT 0 CHECK (show_number IN (0, 1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
) STRICT;
CREATE INDEX publishers_user_id ON publishers (user_id) WHERE user_id IS NOT NULL;

-- One row per item: a skill, MCP server, prompt, assistant or connector.
-- `seq` is the row number, used only by the search index (item_search's
-- rowid); everything else refers to items by `id`.
--
-- status: draft and pending (not yet out); listed (仅收录: reachable by its
-- address or exact name, but not browsed, ranked or recommended); public;
-- retired (stopped by its author or its source); removed (taken down; always
-- with an advisory, H2). Only public items are in the search index and the
-- facet counts. `listed_reasons` says why an item is listed rather than
-- public (JSON array, e.g. ["no_repository", "bulk_publisher"]).
--
-- Title and summary are kept per language (the latest version's listing, see
-- item_versions.listing); either may be missing, and readers fall back to the
-- other. `quality` (0 to 1) is lowered for stuffed descriptions, and
-- multiplies relevance and popularity. `dedupe_key` names what the item
-- installs (a package, a remote endpoint, a SKILL.md), so that copies of one
-- thing published under several names stay listed.
CREATE TABLE items (
  seq               INTEGER PRIMARY KEY,
  id                TEXT    NOT NULL UNIQUE,
  publisher_id      TEXT    NOT NULL REFERENCES publishers (id),
  name              TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('skill', 'mcp', 'prompt', 'assistant', 'connector')),
  status            TEXT    NOT NULL CHECK (status IN ('draft', 'pending', 'listed', 'public', 'retired', 'removed')),
  visibility        TEXT    NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  featured          INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  listed_reasons    TEXT    NOT NULL DEFAULT '[]',
  title_en          TEXT,
  title_zh          TEXT,
  summary_en        TEXT,
  summary_zh        TEXT,
  source            TEXT    NOT NULL CHECK (source IN ('registry', 'github', 'upload', 'form')),
  source_key        TEXT    UNIQUE,
  dedupe_key        TEXT,
  repository_url    TEXT,
  website_url       TEXT,
  license           TEXT,
  runtime           TEXT    NOT NULL DEFAULT 'none',
  risk              TEXT    NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
  reviewed          INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  latest_version_id TEXT,
  latest_revision   INTEGER NOT NULL DEFAULT 0,
  installs          INTEGER NOT NULL DEFAULT 0,
  installs_30d      INTEGER NOT NULL DEFAULT 0,
  stars             INTEGER NOT NULL DEFAULT 0,
  repo_stars        INTEGER,
  quality           REAL    NOT NULL DEFAULT 1,
  popularity        REAL    NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  version_at        TEXT    NOT NULL,
  published_at      TEXT,
  UNIQUE (publisher_id, name)
) STRICT;
-- Browsing reads one page of an index in order, from a cursor (no OFFSET):
-- by popularity, newest and recently updated, across all kinds or one.
CREATE INDEX items_popular ON items (status, visibility, popularity DESC, id DESC);
CREATE INDEX items_popular_kind ON items (status, visibility, kind, popularity DESC, id DESC);
CREATE INDEX items_newest ON items (status, visibility, published_at DESC, id DESC);
CREATE INDEX items_newest_kind ON items (status, visibility, kind, published_at DESC, id DESC);
CREATE INDEX items_updated ON items (status, visibility, version_at DESC, id DESC);
CREATE INDEX items_updated_kind ON items (status, visibility, kind, version_at DESC, id DESC);
CREATE INDEX items_publisher ON items (publisher_id, status, popularity DESC, id DESC);
CREATE INDEX items_dedupe_key ON items (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX items_name ON items (name);

-- Every published state of an item. Its content never changes once written
-- (a yanked or blocked version stays, marked); only what is derived from it
-- may be filled in later. `revision` counts 1, 2, 3 per item; `version` is
-- the author's own version string, if any.
--
-- `content_sha256` is the hash of what was imported or uploaded (for the
-- registry, its server.json), so a re-import that changed nothing makes no
-- new revision. Files are listed in version_files and stored in R2 by hash;
-- `archive_sha256` is the whole package as one deterministic zip. `hosted` is
-- 0 when the license does not allow us to redistribute the files: then only
-- their list and hashes are kept, and clients fetch them from `source_url` at
-- `source_commit`.
--
-- JSON columns: metadata (the normalized standard format: SKILL.md
-- frontmatter, server.json, ...), permissions (declared and detected),
-- checks (format, secrets, rules, quality), listing (title, summary and tags
-- per language, each with where it came from), packages (npm, PyPI, ...
-- pinned to an exact version and the registry's hash), connector and tools
-- (H2), review (the model review, while it is switched on).
-- `readme` is the R2 key of the description rendered to safe HTML when the
-- version was made; `excerpt`, the start of it as plain text, for search.
CREATE TABLE item_versions (
  id             TEXT    PRIMARY KEY,
  item_id        TEXT    NOT NULL REFERENCES items (id),
  revision       INTEGER NOT NULL,
  version        TEXT,
  status         TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'yanked', 'blocked')),
  risk           TEXT    NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
  content_sha256 TEXT    NOT NULL,
  archive_sha256 TEXT,
  archive_size   INTEGER,
  file_count     INTEGER NOT NULL DEFAULT 0,
  files_size     INTEGER NOT NULL DEFAULT 0,
  hosted         INTEGER NOT NULL DEFAULT 1 CHECK (hosted IN (0, 1)),
  source_commit  TEXT,
  source_url     TEXT,
  metadata       TEXT    NOT NULL,
  permissions    TEXT    NOT NULL,
  checks         TEXT    NOT NULL,
  listing        TEXT    NOT NULL,
  packages       TEXT    NOT NULL DEFAULT '[]',
  connector      TEXT,
  tools          TEXT,
  review         TEXT,
  readme         TEXT,
  excerpt        TEXT,
  created_at     TEXT    NOT NULL,
  UNIQUE (item_id, revision)
) STRICT;

-- The files of a version: path (NFC, '/'-separated, relative to the package
-- root), SHA-256, size, and whether it is executable.
CREATE TABLE version_files (
  version_id TEXT    NOT NULL REFERENCES item_versions (id),
  path       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  PRIMARY KEY (version_id, path)
) STRICT, WITHOUT ROWID;

-- Full-text search over public items; rowid is items.seq. The tokenizer only
-- splits on spaces and punctuation, so Chinese characters are written apart
-- and queried as characters in a row (api/harness/text.ts). Columns are
-- weighted name > keywords > title > summary > body.
-- A virtual table: this database cannot be exported with `wrangler d1 export`.
CREATE VIRTUAL TABLE item_search USING fts5 (
  name, keywords, title, summary, body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Tags, in both languages. `match` lists words (either language) that tag an
-- item automatically when they appear in its name, title or summary; tag
-- names also go into the search index, so a Chinese query finds an English
-- item with a matching tag.
CREATE TABLE tags (
  id         TEXT    PRIMARY KEY,
  name_en    TEXT    NOT NULL,
  name_zh    TEXT    NOT NULL,
  match      TEXT    NOT NULL DEFAULT '[]',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
) STRICT;

CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES items (id),
  tag_id  TEXT NOT NULL REFERENCES tags (id),
  PRIMARY KEY (item_id, tag_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX item_tags_tag_id ON item_tags (tag_id, item_id);

-- How many public items each kind, tag and runtime has ('all', 'kind:mcp',
-- 'tag:database', 'runtime:node'), kept up to date as items change and
-- recounted daily. Listings show these instead of counting.
CREATE TABLE facets (
  key        TEXT    PRIMARY KEY,
  count      INTEGER NOT NULL,
  updated_at TEXT    NOT NULL
) STRICT;

-- Where imports come from, and how far each got. A sync runs as a chain of
-- queue jobs; `state` is 'running' while one is under way, and a sync whose
-- lease ran out is presumed dead and started again, so nothing stays stuck.
--   'mcp-registry': `cursor` is the page being synced; `synced_at` the start
--     of the last complete sync, the next one's updated_since.
--   'github:<owner>/<repo>': `synced_ref` is the last imported commit.
CREATE TABLE import_sources (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('registry', 'github')),
  url         TEXT    NOT NULL,
  config      TEXT    NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  state       TEXT    NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running')),
  lease_until TEXT,
  cursor      TEXT,
  synced_at   TEXT,
  synced_ref  TEXT,
  last_error  TEXT,
  stats       TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
) STRICT;

-- npm and PyPI lookups for the packages that MCP servers launch: whether the
-- exact version exists, and its hashes and install scripts (JSON `data`).
-- Shared by every item that names the same package version.
CREATE TABLE package_versions (
  registry_type TEXT    NOT NULL,
  identifier    TEXT    NOT NULL,
  version       TEXT    NOT NULL,
  found         INTEGER NOT NULL CHECK (found IN (0, 1)),
  data          TEXT,
  checked_at    TEXT    NOT NULL,
  PRIMARY KEY (registry_type, identifier, version)
) STRICT, WITHOUT ROWID;

-- The rule checks' patterns (docs: section 7). They live here and not in the
-- repository; a fresh database has none, and the checks then pass on the
-- built-in structural checks alone. A pattern is a JavaScript regular
-- expression matched against each logical line (continued lines joined);
-- `exclude`, if it matches the same line, cancels that one match only.
-- `scope` limits a rule to some files: 'all'; 'code' (scripts and docs,
-- where commands are written down); 'script' (scripts only); 'text' (docs).
CREATE TABLE rules (
  id         TEXT    PRIMARY KEY,
  category   TEXT    NOT NULL,
  severity   TEXT    NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  scope      TEXT    NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'code', 'script', 'text')),
  pattern    TEXT    NOT NULL,
  flags      TEXT    NOT NULL DEFAULT 'i',
  exclude    TEXT,
  message_en TEXT    NOT NULL,
  message_zh TEXT    NOT NULL,
  source     TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
) STRICT;

-- What was decided about an item and why: status changes, raised risks,
-- takedowns. Append-only.
CREATE TABLE moderation_events (
  id         TEXT PRIMARY KEY,
  item_id    TEXT,
  version_id TEXT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  reason     TEXT,
  data       TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX moderation_events_item_id ON moderation_events (item_id, created_at);

INSERT INTO import_sources (id, kind, url, created_at, updated_at) VALUES
  ('mcp-registry', 'registry', 'https://registry.modelcontextprotocol.io/v0.1/servers', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
