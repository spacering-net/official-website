-- When each publisher's picture was last looked for (api/harness/importers/avatars.ts):
-- it is looked for again 30 days later. `avatar` is where the picture is kept on
-- this site (/api/avatars/<publisher id>/<file>), or null for none.
ALTER TABLE publishers ADD COLUMN avatar_checked_at TEXT;
