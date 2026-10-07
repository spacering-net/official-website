-- More skill repositories, as 0003 lists them. image-blaster keeps its skills
-- where Claude Code looks for a project's own (.claude/skills), so that is
-- its path; they run the repository's scripts, so they work in a clone of it.

INSERT INTO import_sources (id, kind, url, config, created_at, updated_at) VALUES
  ('github:neilsonnn/image-blaster', 'github', 'https://github.com/neilsonnn/image-blaster', '{"paths":[".claude/skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
