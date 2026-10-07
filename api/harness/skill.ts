import { parse } from 'yaml';
import { LIMITS } from './limits';
import { NAME_RE } from './text';

/** The six fields of the Agent Skills specification's SKILL.md frontmatter. */
const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  /** fields beyond the specification (Claude Code's own, mostly), kept but flagged: claude.ai and the Skills API refuse them */
  extra: Record<string, unknown>;
}

export interface SkillParse {
  meta?: SkillMeta;
  body: string;
  errors: string[];
  warnings: string[];
}

/**
 * Split a Markdown file's YAML frontmatter from its body. Null when it has no
 * frontmatter block.
 */
export function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const t = text.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  return m ? { yaml: m[1], body: t.slice(m[0].length) } : null;
}

/** YAML from someone else's package: core schema only, few aliases, no duplicate keys. */
export function parseYaml(yaml: string): unknown {
  return parse(yaml, { schema: 'core', maxAliasCount: 20, uniqueKeys: true, prettyErrors: false });
}

/**
 * Read and check a SKILL.md against the Agent Skills specification: `name`
 * follows the naming rule and matches the folder; `description` is 1 to 1024
 * characters. `folder` is the skill's directory name. `lenient` (imports)
 * turns an over-long description into a warning: some well-used skills have
 * one, and agents other than claude.ai accept it.
 */
export function parseSkill(text: string, folder: string, { lenient = false } = {}): SkillParse {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fm = splitFrontmatter(text);
  if (!fm) return { body: text, errors: ['frontmatter_missing'], warnings };
  let data: unknown;
  try {
    data = parseYaml(fm.yaml);
  } catch {
    return { body: fm.body, errors: ['frontmatter_invalid'], warnings };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { body: fm.body, errors: ['frontmatter_invalid'], warnings };
  const d = data as Record<string, unknown>;

  const name = typeof d.name === 'string' ? d.name.trim() : '';
  if (!name) errors.push('name_missing');
  else if (!NAME_RE.test(name)) errors.push('name_invalid');
  else if (name !== folder) warnings.push('name_differs_from_folder');

  const description = typeof d.description === 'string' ? d.description.trim() : '';
  if (!description) errors.push('description_missing');
  else if (description.length > LIMITS.descriptionChars) (lenient ? warnings : errors).push('description_too_long');

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  let metadata: Record<string, string> | undefined;
  if (d.metadata !== undefined) {
    if (d.metadata && typeof d.metadata === 'object' && !Array.isArray(d.metadata)) {
      metadata = Object.fromEntries(Object.entries(d.metadata as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    } else warnings.push('metadata_invalid');
  }
  const tools = d['allowed-tools'];
  const allowedTools = Array.isArray(tools)
    ? tools.filter((t): t is string => typeof t === 'string')
    : typeof tools === 'string'
      ? tools.split(/[\s,]+/).filter(Boolean)
      : undefined;
  const compatibility = str(d.compatibility);
  if (compatibility && compatibility.length > 500) warnings.push('compatibility_too_long');

  const extra = Object.fromEntries(Object.entries(d).filter(([k]) => !SPEC_FIELDS.has(k)));
  if (Object.keys(extra).length) warnings.push('extra_fields');

  return {
    meta: errors.length ? undefined : { name, description, license: str(d.license), compatibility, metadata, allowedTools, extra },
    body: fm.body,
    errors,
    warnings,
  };
}
