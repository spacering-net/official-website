-- Harness data version 8: plugins (docs/harness-plugins.md, section 4).
--
-- A plugin is an item of its own (kind 'plugin'): a repository's plugin that
-- has to be used whole, its skills and assistants no longer items on their
-- own. Those members are 'deleted': read everywhere as if there were no such
-- item, their rows kept so that they come back, at the same address and
-- revision, if the plugin goes. A plugin's new revision is 'staged' (seen by
-- no reader) until the reconcile of a complete import makes it current, the
-- members' deletion in the same batch.
--
-- Migrations here only add, but this one rebuilds the items subtree (items,
-- item_versions, version_files, item_tags) once, to widen three CHECKs: kind
-- 'plugin', items.status 'deleted' and item_versions.status 'staged'. SQLite
-- cannot alter a CHECK, and rebuilding only the parent fails at COMMIT (the
-- children's foreign-key violations are counted when the old parent is
-- dropped and never cleared), so the children are rebuilt with it: new tables
-- referencing the new ones, rows copied as they are (seq and id unchanged:
-- item_search's rowid is items.seq), old tables dropped grandchildren first,
-- new ones renamed into place (a rename rewrites the references to it), then
-- every index made again. Rehearsed on a copy of production (70,834 items):
-- one batch, 5.8 s on D1.
--
-- New columns:
--   items.covered_by: the plugin item a deleted member belongs to;
--   items.covered_status: the member's status when the plugin took it (a
--     member that was public keeps its dedupe key while deleted);
--   item_versions.committed_at: when the source committed the version (the
--     date versions are shown with; filled for each item's latest version
--     here, for older ones by the backfill job);
--   import_sources.staged_run: the last complete import (import_runs), the
--     only one a reconcile acts on; import_sources.lease: the reconcile
--     holding the source.
-- Only the reconcile (api/harness/reconcile.ts) sets or clears covered_*.

PRAGMA defer_foreign_keys = on;

CREATE TABLE items_new (
  seq               INTEGER PRIMARY KEY,
  id                TEXT    NOT NULL UNIQUE,
  publisher_id      TEXT    NOT NULL REFERENCES publishers (id),
  name              TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('skill', 'mcp', 'prompt', 'assistant', 'connector', 'plugin')),
  status            TEXT    NOT NULL CHECK (status IN ('draft', 'pending', 'listed', 'public', 'retired', 'removed', 'deleted')),
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
  card              TEXT,
  boost             REAL    NOT NULL DEFAULT 0,
  covered_by        TEXT,
  covered_status    TEXT    CHECK (covered_status IN ('public', 'listed')),
  UNIQUE (publisher_id, name)
) STRICT;

CREATE TABLE item_versions_new (
  id             TEXT    PRIMARY KEY,
  item_id        TEXT    NOT NULL REFERENCES items_new (id),
  revision       INTEGER NOT NULL,
  version        TEXT,
  status         TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'yanked', 'blocked', 'staged')),
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
  committed_at   TEXT,
  UNIQUE (item_id, revision)
) STRICT;

CREATE TABLE version_files_new (
  version_id TEXT    NOT NULL REFERENCES item_versions_new (id),
  path       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  PRIMARY KEY (version_id, path)
) STRICT, WITHOUT ROWID;

CREATE TABLE item_tags_new (
  item_id TEXT NOT NULL REFERENCES items_new (id),
  tag_id  TEXT NOT NULL REFERENCES tags (id),
  PRIMARY KEY (item_id, tag_id)
) STRICT, WITHOUT ROWID;

INSERT INTO items_new (seq, id, publisher_id, name, kind, status, visibility, featured, listed_reasons,
    title_en, title_zh, summary_en, summary_zh, source, source_key, dedupe_key, repository_url, website_url,
    license, runtime, risk, reviewed, latest_version_id, latest_revision, installs, installs_30d, stars,
    repo_stars, quality, popularity, created_at, updated_at, version_at, published_at, card, boost)
  SELECT seq, id, publisher_id, name, kind, status, visibility, featured, listed_reasons,
    title_en, title_zh, summary_en, summary_zh, source, source_key, dedupe_key, repository_url, website_url,
    license, runtime, risk, reviewed, latest_version_id, latest_revision, installs, installs_30d, stars,
    repo_stars, quality, popularity, created_at, updated_at, version_at, published_at, card, boost
  FROM items;

-- each item's latest version is dated by when its source committed it (items.version_at); older ones
-- by the backfill job. A keyed copy of that date, read while copying, then dropped.
CREATE TABLE latest_dates (version_id TEXT PRIMARY KEY, at TEXT NOT NULL) STRICT, WITHOUT ROWID;
INSERT INTO latest_dates (version_id, at) SELECT latest_version_id, version_at FROM items WHERE latest_version_id IS NOT NULL;

INSERT INTO item_versions_new (id, item_id, revision, version, status, risk, content_sha256, archive_sha256,
    archive_size, file_count, files_size, hosted, source_commit, source_url, metadata, permissions, checks,
    listing, packages, connector, tools, review, readme, excerpt, created_at, committed_at)
  SELECT v.id, v.item_id, v.revision, v.version, v.status, v.risk, v.content_sha256, v.archive_sha256,
    v.archive_size, v.file_count, v.files_size, v.hosted, v.source_commit, v.source_url, v.metadata, v.permissions, v.checks,
    v.listing, v.packages, v.connector, v.tools, v.review, v.readme, v.excerpt, v.created_at, d.at
  FROM item_versions v LEFT JOIN latest_dates d ON d.version_id = v.id;

DROP TABLE latest_dates;

INSERT INTO version_files_new (version_id, path, sha256, size, executable)
  SELECT version_id, path, sha256, size, executable FROM version_files;

INSERT INTO item_tags_new (item_id, tag_id) SELECT item_id, tag_id FROM item_tags;

DROP TABLE version_files;
DROP TABLE item_tags;
DROP TABLE item_versions;
DROP TABLE items;

ALTER TABLE items_new RENAME TO items;
ALTER TABLE item_versions_new RENAME TO item_versions;
ALTER TABLE version_files_new RENAME TO version_files;
ALTER TABLE item_tags_new RENAME TO item_tags;

CREATE INDEX items_popular ON items (status, visibility, popularity DESC, id DESC);
CREATE INDEX items_popular_kind ON items (status, visibility, kind, popularity DESC, id DESC);
CREATE INDEX items_newest ON items (status, visibility, published_at DESC, id DESC);
CREATE INDEX items_newest_kind ON items (status, visibility, kind, published_at DESC, id DESC);
CREATE INDEX items_updated ON items (status, visibility, version_at DESC, id DESC);
CREATE INDEX items_updated_kind ON items (status, visibility, kind, version_at DESC, id DESC);
CREATE INDEX items_publisher ON items (publisher_id, status, popularity DESC, id DESC);
CREATE INDEX items_dedupe_key ON items (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX items_name ON items (name);
CREATE INDEX items_covered_by ON items (covered_by) WHERE covered_by IS NOT NULL;
CREATE INDEX item_tags_tag_id ON item_tags (tag_id, item_id);
-- what a package's zip and files are served by: only those of a version that is out (not staged)
CREATE INDEX item_versions_archive ON item_versions (archive_sha256) WHERE archive_sha256 IS NOT NULL;
CREATE INDEX version_files_sha256 ON version_files (sha256);

ALTER TABLE import_sources ADD COLUMN staged_run TEXT;
ALTER TABLE import_sources ADD COLUMN lease TEXT;


-- Each complete import of a GitHub source: its commit and its plugins (JSON:
-- each plugin's source key, the version it saved, and its members' source
-- keys), what the reconcile commits.
CREATE TABLE import_runs (
  run_id       TEXT PRIMARY KEY,
  source       TEXT NOT NULL REFERENCES import_sources (id),
  "commit"     TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  plugins      TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX import_runs_source ON import_runs (source, completed_at);

-- The skills and assistants in a plugin version: its page lists them, search
-- reads their names, and two versions' tree hashes tell which changed.
CREATE TABLE plugin_components (
  version_id  TEXT NOT NULL REFERENCES item_versions (id),
  kind        TEXT NOT NULL CHECK (kind IN ('skill', 'assistant')),
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  tree_sha256 TEXT NOT NULL,
  dedupe_key  TEXT,
  title       TEXT,
  summary     TEXT,
  PRIMARY KEY (version_id, kind, name)
) STRICT, WITHOUT ROWID;

-- A plugin's releases, as its repository published them: the notes are kept
-- rendered in R2 (notes_key). Only a record: releases make no revisions.
CREATE TABLE releases (
  item_id       TEXT NOT NULL REFERENCES items (id),
  version       TEXT NOT NULL,
  tag           TEXT,
  url           TEXT,
  notes_key     TEXT,
  published_at  TEXT,
  source_commit TEXT,
  PRIMARY KEY (item_id, version)
) STRICT, WITHOUT ROWID;

-- Plugin packages a maintainer has looked at and approved, by their tree
-- hash (item_versions.content_sha256): a plugin that runs things on its own
-- (hooks, code, MCP servers) is installed whole only at an approved hash.
CREATE TABLE exec_approvals (
  content_sha256 TEXT PRIMARY KEY,
  approved_by    TEXT NOT NULL,
  approved_at    TEXT NOT NULL,
  note           TEXT
) STRICT;
