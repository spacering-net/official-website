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
 * Frontmatter as Claude Code reads it: a top-level value that is not valid
 * YAML as written, such as an unquoted `[pr-number] [priority]` (the form
 * Claude Code's own documentation gives `argument-hint`) or a sentence with a
 * `: ` in it, is the text it is. Each such value, with the lines continuing
 * it, comes back quoted; null when none needed it.
 */
export function quoteLooseValues(yaml: string): string | null {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; ) {
    const m = /^([A-Za-z0-9_][\w.-]*):[ \t]+(\S.*)$/.exec(lines[i]);
    let end = i + 1;
    // quoted values and block scalars are as their authors meant them
    if (m && !/^["']/.test(m[2]) && !/^[|>][-+0-9]*[ \t]*(#.*)?$/.test(m[2])) {
      while (end < lines.length && /^[ \t]+\S/.test(lines[end])) end++;
      let valid = true;
      try {
        parseYaml(lines.slice(i, end).join('\n'));
      } catch {
        valid = false;
      }
      if (!valid) {
        const text = [m[2], ...lines.slice(i + 1, end).map((l) => l.trim())].join(' ').trim();
        out.push(`${m[1]}: ${JSON.stringify(text)}`);
        changed = true;
        i = end;
        continue;
      }
    }
    out.push(...lines.slice(i, end));
    i = end;
  }
  return changed ? out.join('\n') : null;
}

/** Tools listed as text: separated by spaces or commas, a pattern's own spaces (and parentheses, one level deep) kept: `Bash(ls *)`. */
export const toolList = (text: string) => text.match(/[^\s,()]+(?:\((?:[^()]|\([^()]*\))*\))?/g) ?? [];

/**
 * Read and check a SKILL.md against the Agent Skills specification: `name`
 * follows the naming rule and matches the folder; `description` is 1 to 1024
 * characters. `folder` is the skill's directory name. `lenient` (imports)
 * turns an over-long description into a warning: some well-used skills have
 * one, and agents other than claude.ai accept it. It also reads frontmatter
 * values that are not valid YAML as written the way Claude Code does, as
 * text (quoteLooseValues), with a warning.
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
    const loose = lenient ? quoteLooseValues(fm.yaml) : null;
    if (loose === null) return { body: fm.body, errors: ['frontmatter_invalid'], warnings };
    try {
      data = parseYaml(loose);
    } catch {
      return { body: fm.body, errors: ['frontmatter_invalid'], warnings };
    }
    warnings.push('frontmatter_unquoted');
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
      ? toolList(tools)
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
