-- Prompts (docs: harness-prompts.md): what a card shows besides its title
-- and summary, what an item's own signals add to its popularity, pictures
-- copied here from where sources name them, tags for what prompts make, and
-- the first prompt collection.

-- What an item's card shows besides its title and summary, as JSON, so that
-- a list never reads the versions table. By kind; for a prompt: the start of
-- its text, where its cover and its moving preview come from, the model it
-- was written for, who shared it, how many results it has, and whether only
-- part of it was shared (api/harness/model.ts, StoredPromptCard).
ALTER TABLE items ADD COLUMN card TEXT;

-- What an item's own signals add to its popularity, besides stars: for a
-- prompt, the results people made with it. popularity = quality ×
-- (log10(1 + stars) + boost + 2 if featured).
ALTER TABLE items ADD COLUMN boost REAL NOT NULL DEFAULT 0;

-- Pictures shown with items (the results made with a prompt), copied here
-- from where a source names them, so that pages load pictures from this site
-- only: their CSP allows nothing else. Keyed by that address; once fetched,
-- `sha256` names the copy in R2 (media/<sha256>), served from
-- /api/harness/v1/media/<sha256>.<ext>. status: pending until first looked
-- at; ok; missing when the address answered with something that is not a
-- picture (looked at again after 30 days); failed when it gave no clear
-- answer (again after 3).
CREATE TABLE media (
  url        TEXT    PRIMARY KEY,
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'missing', 'failed')),
  sha256     TEXT,
  type       TEXT,
  width      INTEGER,
  height     INTEGER,
  size       INTEGER,
  checked_at TEXT,
  created_at TEXT    NOT NULL
) STRICT;
CREATE INDEX media_due ON media (status, checked_at);

INSERT INTO tags (id, name_en, name_zh, match, sort, created_at) VALUES
  ('creative-coding', 'Creative coding', '创意编程', '["creative coding","generative art","p5.js","processing.js","shader","shaders","glsl","创意编程","生成艺术"]', 235, '2026-10-07T00:00:00.000Z'),
  ('3d', '3D', '3D', '["3d","three.js","threejs","webgl","webgpu","blender","三维"]', 255, '2026-10-07T00:00:00.000Z'),
  ('animation', 'Animation', '动画', '["animation","animations","animated","motion graphics","after effects","lottie","manim","动画","动效"]', 275, '2026-10-07T00:00:00.000Z'),
  ('games', 'Games', '游戏', '["game","games","gaming","godot","unity3d","unreal engine","游戏"]', 285, '2026-10-07T00:00:00.000Z');

-- The first prompt collection: videos people made with Claude Opus 5.5, each
-- with the prompt its creator shared (docs: harness-prompts.md, section 5).
-- Its config says which field of an entry holds what, so another collection
-- is data, not code. The prompts and videos belong to their creators, not to
-- the repository's license: they are shown credited, with a link to the
-- original post. Moving previews exist for the entries its README highlights;
-- the rest are found missing and looked at again now and then.
INSERT INTO import_sources (id, kind, url, config, created_at, updated_at) VALUES
  ('github:yihui-dev/awesome-opus5-5-videos', 'github', 'https://github.com/yihui-dev/awesome-opus5-5-videos',
   '{"kind":"prompt","reader":"json","file":"data/videos.json","fields":{"id":"slug","text":"prompt","partial":"prompt_partial","by":"author","byUrl":"author_url","link":"post_url","cover":"poster_url","category":"category","labels":"tech_tags","added":"added"},"motion":"https://media.skillry.dev/opus-5-5/{id}/preview.webp","model":"claude-opus-5-5","rights":"creators","media":["media.skillry.dev"],"categories":{"motion":{"en":"Motion graphics","zh":"动态图形"},"explainer":{"en":"Explainer","zh":"讲解"},"3d":{"en":"3D scene","zh":"3D 场景"},"interactive":{"en":"Game or interactive","zh":"游戏与互动"}},"tags":{"motion":["animation","video"],"explainer":["animation","education"],"3d":["3d"],"interactive":["games"],"threejs":["3d"],"webgl":["3d"],"shader":["creative-coding"],"canvas":["creative-coding"],"svg":["creative-coding"],"particles":["creative-coding"],"physics":["creative-coding"],"pixel":["creative-coding"],"playable":["games"],"audio":["audio"],"ai-image":["images"]}}',
   '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
