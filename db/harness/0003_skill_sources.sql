-- The skill repositories imported at the start (docs: section 12): official
-- collections from the companies behind the agents and the tools, and
-- well-kept community ones, each under an open license for most of its
-- skills. Each is checked daily for a new commit. `config.paths` keeps to the
-- folders where a repository keeps its skills (copies made for other agents
-- are left out); `config.hidden` admits hidden folders below them.

INSERT INTO import_sources (id, kind, url, config, created_at, updated_at) VALUES
  ('github:anthropics/skills', 'github', 'https://github.com/anthropics/skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:anthropics/claude-plugins-official', 'github', 'https://github.com/anthropics/claude-plugins-official', '{}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:openai/skills', 'github', 'https://github.com/openai/skills', '{"paths":["skills/.curated"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:google-gemini/gemini-skills', 'github', 'https://github.com/google-gemini/gemini-skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:microsoft/skills', 'github', 'https://github.com/microsoft/skills', '{"paths":[".github/plugins"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:huggingface/skills', 'github', 'https://github.com/huggingface/skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:vercel-labs/agent-skills', 'github', 'https://github.com/vercel-labs/agent-skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:cloudflare/skills', 'github', 'https://github.com/cloudflare/skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:supabase/agent-skills', 'github', 'https://github.com/supabase/agent-skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:firebase/agent-skills', 'github', 'https://github.com/firebase/agent-skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:stripe/ai', 'github', 'https://github.com/stripe/ai', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:getsentry/skills', 'github', 'https://github.com/getsentry/skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:expo/skills', 'github', 'https://github.com/expo/skills', '{"paths":["plugins/expo/skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:hashicorp/agent-skills', 'github', 'https://github.com/hashicorp/agent-skills', '{"paths":["plugins"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:callstackincubator/agent-skills', 'github', 'https://github.com/callstackincubator/agent-skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:trailofbits/skills', 'github', 'https://github.com/trailofbits/skills', '{"paths":["plugins"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:obra/superpowers', 'github', 'https://github.com/obra/superpowers', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:addyosmani/agent-skills', 'github', 'https://github.com/addyosmani/agent-skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:mattpocock/skills', 'github', 'https://github.com/mattpocock/skills', '{"paths":["skills/engineering","skills/productivity","skills/misc"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:wshobson/agents', 'github', 'https://github.com/wshobson/agents', '{"paths":["plugins"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:alirezarezvani/claude-skills', 'github', 'https://github.com/alirezarezvani/claude-skills', '{}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:orchestra-research/ai-research-skills', 'github', 'https://github.com/Orchestra-Research/AI-Research-SKILLs', '{}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:muratcankoylan/agent-skills-for-context-engineering', 'github', 'https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:itsmostafa/aws-agent-skills', 'github', 'https://github.com/itsmostafa/aws-agent-skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:jimliu/baoyu-skills', 'github', 'https://github.com/JimLiu/baoyu-skills', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:kkkkhazix/khazix-skills', 'github', 'https://github.com/KKKKhazix/khazix-skills', '{}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:othmanadi/planning-with-files', 'github', 'https://github.com/OthmanAdi/planning-with-files', '{"paths":["skills"]}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
  ('github:blader/humanizer', 'github', 'https://github.com/blader/humanizer', '{}', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
