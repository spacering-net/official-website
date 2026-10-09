-- Assistants (docs: harness-assistants.md): Claude Code subagent definitions,
-- imported in the same run as their repositories' skills. Four tags they need
-- more than the first set gave, and Writing kept to prose; which skill
-- repositories' assistants to take; and the first collections of assistants,
-- taken for their assistants only.
--
-- A source's config says which files are assistants (`assistants`, see
-- api/harness/importers/assistants.ts), and `"skills": false` takes none of
-- its skills. Code from before assistants reads neither, and would take these
-- collections for their skills (ECC alone has a thousand): apply this after
-- the code that reads them is out, then queue a forced import of each source
-- (their commits may not have changed since their last import).

INSERT INTO tags (id, name_en, name_zh, match, sort, created_at) VALUES
  ('documentation', 'Documentation', '技术文档', '["documentation","docs","api documentation","technical writing","readme","mermaid","diagrams","技术文档"]', 75, '2026-10-09T00:00:00.000Z'),
  ('backend', 'Backend', '后端', '["backend","back-end","api design","rest api","graphql","fastapi","django","flask","rails","spring boot","express","nestjs","后端"]', 228, '2026-10-09T00:00:00.000Z'),
  ('marketing', 'Marketing and SEO', '营销与 SEO', '["seo","marketing","content strategy","growth","campaign","campaigns","brand","keyword research","营销","推广"]', 365, '2026-10-09T00:00:00.000Z'),
  ('architecture', 'Architecture', '架构', '["architecture","architect","architects","system design","microservices","event sourcing","cqrs","c4","domain-driven","ddd","monorepo","架构"]', 415, '2026-10-09T00:00:00.000Z');

-- Writing is prose: "after writing code", "writing tests" say when a coding
-- assistant is called, and video or collaborative editing is not writing
-- either. A phrase after "!" does not count for the tag (api/harness/tags.ts).
UPDATE tags SET match = '["writing","copywriting","blog","blogging","essay","proofreading","editing","写作","文案","!writing code","!writing or modifying code","!writing tests","!writing test","!test writing","!writing sql","!writing queries","!writing new features","!writing scripts","!code editing","!editing code","!editing files","!file editing","!collaborative editing","!video editing","!image editing","!photo editing"]'
  WHERE id = 'writing';

-- The skill repositories whose assistants stand on their own. trailofbits'
-- are steps of its plugins' pipelines; image-blaster's need its own scripts.
UPDATE import_sources SET config = json_set(config, '$.assistants', json('{"paths":["plugins"]}')), updated_at = '2026-10-09T00:00:00.000Z'
  WHERE id = 'github:wshobson/agents';
UPDATE import_sources SET config = json_set(config, '$.assistants', json('{"paths":["plugins"]}')), updated_at = '2026-10-09T00:00:00.000Z'
  WHERE id = 'github:anthropics/claude-plugins-official';
UPDATE import_sources SET config = json_set(config, '$.assistants', json('{"exclude":["docs"]}')), updated_at = '2026-10-09T00:00:00.000Z'
  WHERE id = 'github:alirezarezvani/claude-skills';
UPDATE import_sources SET config = json_set(config, '$.assistants', json('{"paths":["agents"]}')), updated_at = '2026-10-09T00:00:00.000Z'
  WHERE id IN ('github:addyosmani/agent-skills', 'github:getsentry/skills', 'github:firebase/agent-skills');
UPDATE import_sources SET config = json_set(config, '$.assistants', json('{"paths":["providers/claude"]}')), updated_at = '2026-10-09T00:00:00.000Z'
  WHERE id = 'github:stripe/ai';

-- Collections of assistants. agency-agents keeps them in a folder per
-- department, not in `agents` folders; the others in their plugins'.
INSERT INTO import_sources (id, kind, url, config, created_at, updated_at) VALUES
  ('github:msitarzewski/agency-agents', 'github', 'https://github.com/msitarzewski/agency-agents',
   '{"skills":false,"assistants":{"match":"all","exclude":["integrations","examples"]}}', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('github:affaan-m/ecc', 'github', 'https://github.com/affaan-m/ECC',
   '{"skills":false,"assistants":{"paths":["agents"]}}', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('github:anthropics/financial-services', 'github', 'https://github.com/anthropics/financial-services',
   '{"skills":false,"assistants":{"paths":["plugins"]}}', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('github:anthropics/knowledge-work-plugins', 'github', 'https://github.com/anthropics/knowledge-work-plugins',
   '{"skills":false,"assistants":{"paths":["partner-built"]}}', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
