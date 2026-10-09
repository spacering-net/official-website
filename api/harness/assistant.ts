import { LIMITS } from './limits';
import type { Access, AssistantExample, AssistantMeta, StoredAssistantCard } from './model';
import type { PackageFile } from './files';
import { firstHeading } from './markdown';
import type { Finding } from './scan/content';
import { skillPermissions, type PermissionProfile } from './scan/permissions';
import { parseYaml, quoteLooseValues, splitFrontmatter, toolList } from './skill';
import { clip, NAME_RE, toName } from './text';

/**
 * Assistants (docs: harness-assistants.md): Claude Code subagent definitions,
 * one Markdown file each. The frontmatter says what the assistant is called,
 * when to hand it work and what it may use; the body is its system prompt.
 * Harness keeps the file as written and reads it here; Codeg turns it into
 * other agents' formats when it installs one.
 */

/** Claude Code's eight colours for subagents. A definition's other colours go to the nearest. */
export const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'] as const;

const COLOR_WORDS: Record<string, string> = {
  magenta: 'pink',
  fuchsia: 'pink',
  rose: 'pink',
  violet: 'purple',
  lavender: 'purple',
  indigo: 'blue',
  navy: 'blue',
  sky: 'blue',
  teal: 'cyan',
  aqua: 'cyan',
  turquoise: 'cyan',
  lime: 'green',
  emerald: 'green',
  mint: 'green',
  amber: 'yellow',
  gold: 'yellow',
  coral: 'orange',
  crimson: 'red',
  scarlet: 'red',
};

/** One of the eight colours for what a definition writes: a name, another colour word, or a hex value by its hue; null for none or a grey. */
export function colorOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if ((COLORS as readonly string[]).includes(v)) return v;
  if (COLOR_WORDS[v]) return COLOR_WORDS[v];
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  // a grey says nothing about which colour
  if (d < 0.12) return null;
  const h = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

// ---------------------------------------------------------------------------
// tools

/** A tool by its name, without the pattern some carry: `Bash(git diff:*)` is Bash. */
const toolName = (tool: string) => tool.replace(/\(.*$/s, '').trim();

/**
 * The tools of each kind of access. Names collections still use but Claude
 * Code has since dropped or renamed (LS, MultiEdit) count too. For an
 * assistant whose tools are not limited, only the tools Claude Code has today
 * (the first ones listed) decide what a `disallowedTools` list takes away.
 */
const CLASSES = {
  read: { now: ['Read', 'Grep', 'Glob'], also: ['LS', 'NotebookRead', 'LSP'] },
  edit: { now: ['Write', 'Edit', 'NotebookEdit'], also: ['MultiEdit'] },
  run: { now: ['Bash', 'PowerShell'], also: ['BashOutput', 'KillShell', 'KillBash', 'Monitor'] },
  web: { now: ['WebFetch', 'WebSearch'], also: [] },
} as const;

/** Tools as a definition lists them: a comma- or space-separated string, or a list; undefined when it lists none. */
function toolsOf(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
  if (typeof value === 'string') return toolList(value);
  return undefined;
}

/** What an assistant may touch, by its tools (null: not limited) less the ones it is denied. */
export function accessOf(tools: string[] | null, disallowed: string[] = []): Access {
  // a pattern (`Bash(rm *)`) denies part of a tool, not the tool
  const denied = new Set(disallowed.filter((t) => !t.includes('(')).map(toolName));
  const has = (kind: keyof typeof CLASSES) => {
    const { now, also } = CLASSES[kind];
    if (tools === null) return now.some((t) => !denied.has(t));
    return tools.some((t) => {
      const name = toolName(t);
      return ([...now, ...also] as string[]).includes(name) && !denied.has(name);
    });
  };
  return { read: has('read'), edit: has('edit'), run: has('run'), web: has('web'), all: tools === null && disallowed.length === 0 };
}

// ---------------------------------------------------------------------------
// examples

const unquote = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“'‘](.*)["”'’]$/s, '$1')
    .trim();

/**
 * One `<example>` block: its context, the first user turn, the first answer,
 * and the commentary. Null without a user turn. The user may be named
 * ("Daisy: …" rather than "user: …"): without a `user:` line, the first
 * speaker that is not the context or the assistant is the user.
 */
function readExample(inner: string): AssistantExample | null {
  const commentary = /<commentary>([\s\S]*?)<\/commentary>/i.exec(inner)?.[1] ?? null;
  const rest = inner.replace(/<commentary>[\s\S]*?<\/commentary>/gi, '\n');
  const lines = rest.split(/\r?\n/);
  const speaker = (line: string) => /^\s*([A-Za-z][\w .'-]{0,30}?)\s*:\s*(.*)$/.exec(line);
  const role = (who: string) => (who === 'context' ? 'context' : who === 'assistant' || who === 'claude' ? 'assistant' : null);
  const userName = lines.some((l) => /^\s*user\s*:/i.test(l))
    ? 'user'
    : (lines.map((l) => speaker(l)?.[1].toLowerCase()).find((s) => s && !role(s)) ?? 'user');
  const parts: Partial<Record<'context' | 'user' | 'assistant', string>> = {};
  let key: keyof typeof parts | null = null;
  for (const line of lines) {
    const m = speaker(line);
    const who = m?.[1].toLowerCase() ?? '';
    const k = role(who) ?? (who === userName ? 'user' : null);
    if (k) {
      // the first turn of each is the example; later turns of a longer one are left out
      key = parts[k] === undefined ? k : null;
      if (key) parts[key] = m![2];
    } else if (key && line.trim()) parts[key] += `\n${line.trim()}`;
  }
  const text = (s: string | null | undefined) => {
    const t = s ? unquote(s) : '';
    return t ? clip(t, 400) : null;
  };
  const user = text(parts.user);
  return user ? { context: text(parts.context), user, assistant: text(parts.assistant), commentary: text(commentary) } : null;
}

/**
 * The `<example>` blocks of a description, read, and the description without
 * them, nor the "Examples:" that introduced them. A description written on
 * one line, with `\n` where its lines break (as YAML keeps it, unquoted), is
 * read as the lines it means.
 */
export function splitExamples(description: string): { text: string; examples: AssistantExample[] } {
  const examples: AssistantExample[] = [];
  const lined = description.replace(/\\n/g, '\n');
  const rest = lined.replace(/<example>([\s\S]*?)<\/example>/gi, (_, inner: string) => {
    const example = readExample(inner);
    if (example) examples.push(example);
    return '\n';
  });
  const text = rest
    .replace(/<\/?examples?>/gi, ' ')
    .trim()
    .replace(/[\s(]*(?:here are (?:some )?)?(?:\bfor\s+)?examples?(?:\s+of\s+[^:\n]{0,40})?\s*:?\s*\)?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { text: text || unquote(lined.replace(/<[^>]+>/g, ' ')), examples };
}

/** A list item's text: markup and the quotes around it taken off. */
const itemText = (s: string) => unquote(s.replace(/\*\*|__|`/g, ''));

/**
 * Things to say to it: the list under its body's "Example interactions" (or
 * "Example prompts") heading, and the user's turns of its examples. At most
 * eight, each at most 300 characters.
 */
export function startersOf(body: string, examples: AssistantExample[]): string[] {
  const out: string[] = [];
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*(?:example\s+(?:interactions?|prompts?|requests?|usage)|sample\s+prompts?|usage\s+examples?)\s*:?\s*$/i.test(l.trim()));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) {
      const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(lines[i]);
      if (m) out.push(itemText(m[1]));
    }
  }
  for (const e of examples) out.push(e.user);
  return [...new Set(out.filter((s) => s.length >= 8).map((s) => clip(s, 300)))].slice(0, 8);
}

// ---------------------------------------------------------------------------
// names and titles

/** Words written their own way when a name is made readable: abbreviations, and names of things. */
const WORDS: Record<string, string> = {
  ...Object.fromEntries(
    [
      'A11y AI AML API APIs ARM AWS B2B BDD CAIO CD CEO CFO CI CLI CMO CMS CPU CQRS CRM CSS CSV CTO DB DDD DevOps DGX DOCX DX E2E ERP ETL FastAPI',
      'GAN GCP GDPR GitHub GitLab GL GPU GraphQL HR HTML HTTP iOS JavaScript JSON JWT K8s KYC LLM LLMs macOS ML MLOps MCP MongoDB MySQL NLP',
      'NoSQL OAuth PDF PHP PM POSIX PostgreSQL PPTX PR QA RAG REST RL SaaS SDK SEO SOC SQL SRE SSR TDD TS TypeScript UI UX WebGL WebGPU',
      'WordPress XLSX XML YAML',
      // names of languages, frameworks and products, in the middle of a name as at its start
      'Android Angular Ansible Azure Bukkit Django Docker Elixir Figma Firebase Flutter Godot Golang Haskell HarmonyOS Java Jira Julia Kafka',
      'Kotlin Kubernetes Laravel LinkedIn Linux Minecraft Notion NotebookLM OpenAI Postgres Python PyTorch Rails React Redis Ruby Rust',
      'Salesforce Scala Shopify Slack Stripe Supabase Svelte Swift TensorFlow Terraform TikTok Unity Vue WeChat YouTube',
    ]
      .join(' ')
      .split(' ')
      .map((w) => [w.toLowerCase(), w]),
  ),
  csharp: 'C#',
  fsharp: 'F#',
  cpp: 'C++',
  dotnet: '.NET',
  nextjs: 'Next.js',
  nodejs: 'Node.js',
  vuejs: 'Vue.js',
};

/**
 * A name made readable: "ui-visual-validator" → "UI visual validator". A
 * collection's `namespace` (cs in cs-ceo-advisor) is left out.
 */
export function humanize(name: string, namespace = ''): string {
  const bare = namespace && name.toLowerCase().startsWith(`${namespace}-`) ? name.slice(namespace.length + 1) : name;
  const words = bare.split(/[-_\s]+/).filter(Boolean).map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  const text = words.join(' ').replace(/\bUI UX\b/, 'UI/UX');
  return WORDS[words[0]?.toLowerCase() ?? ''] ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A title without the word "agent" (or "persona") a heading often puts after
 * a noun that already names one: "Spec Miner Agent" → "Spec Miner",
 * "Statistician Agent Personality" → "Statistician". Where the word before
 * it does not name one ("Research Agent", "QA Agent"), it stays.
 */
export function withoutAgentWord(title: string): string {
  const t = title.trim();
  const m = /^(.*\S)\s+(?:sub-?agent|agent(?:\s+personality)?|persona)$/i.exec(t);
  // Reviewer, Simplifier, Auditor, Strategist, Analyst, Statistician, Assistant, Architect (not Dossier, Reflect)
  return m && /(?:(?<!i)er|fier|or|ist|yst|ian|ant|itect)$/i.test(m[1]) ? m[1] : t;
}

/** A definition whose name is written as a title ("Brand Guardian") rather than as an identifier. */
const isTitle = (name: string) => /\s/.test(name.trim());

/** Headings that say what a part of a prompt is, not what the assistant is called. */
const GENERIC = /^(role|roles|instructions?|system prompt|prompt|overview|purpose|identity|persona|agent|description|context|about)$/i;

/** A heading that is an identifier (`karpathy-reviewer`, `@arm-cortex-expert`), not a title. */
const IDENTIFIER = /^(?:@[\w.-]+|[a-z0-9]+(?:[-_][a-z0-9]+)+)$/;

/**
 * The names an assistant may take in Harness's addresses, the shorter first:
 * a name written as a title gives its own (`Brand Guardian` → brand-guardian),
 * then the file's; a copy that a plugin renamed `<plugin>-<name>` gives the
 * name without the prefix, then its own. Where they agree there is one. Pass
 * the plugin only for a definition the repository has copies of in other
 * plugins: one of its own keeps its name (llm-finetuning-architect is not
 * "architect").
 */
export function assistantNames(name: string, file: string, plugin: string | null): string[] {
  const base = file.replace(/\.(md|markdown)$/i, '');
  if (isTitle(name) || !NAME_RE.test(name)) return [...new Set([toName(name, ''), toName(base, 'assistant')].filter(Boolean))];
  if (plugin && name.startsWith(`${plugin}-`) && NAME_RE.test(name.slice(plugin.length + 1))) return [name.slice(plugin.length + 1), name];
  return [name];
}

/**
 * Names for when an assistant's own are taken under its publisher (by another
 * assistant of the same name in another plugin, or a skill): with its plugin
 * before it (unless the name has it already), then with "agent" after it,
 * before the store numbers it.
 */
export function fallbackNames(name: string, plugin: string | null): string[] {
  const out = [...(plugin && !`-${name}-`.includes(`-${plugin}-`) ? [`${plugin}-${name}`] : []), `${name}-agent`];
  return out.filter((n) => NAME_RE.test(n));
}

/**
 * A display title: a name written as one, else the body's first top-level
 * heading (as skills take theirs), else the shortest name made readable (less
 * the collection's `namespace`). A heading that only repeats the name, as an
 * identifier or before a subtitle ("cs-backend-engineer — Backend
 * Orchestrator"), counts as the name; one that adds it in brackets loses
 * them. Either way without a trailing "Agent" (withoutAgentWord).
 */
export function assistantTitle(name: string, body: string, shortName: string, namespace = ''): string {
  const own = name.trim();
  if (isTitle(own)) return clip(withoutAgentWord(own), 80);
  const lower = own.toLowerCase();
  let heading = (firstHeading(body) ?? '').replace(/[*_`]/g, '').trim();
  heading = heading.replace(/\s*\(([^()]+)\)$/, (whole, inner: string) => (inner.trim().toLowerCase() === lower ? '' : whole)).trim();
  if (heading.toLowerCase().startsWith(lower) && /^\s*(?:$|[—–:|]|-\s)/.test(heading.slice(lower.length))) heading = '';
  // a subtitle after a dash stays in the body: "Healthcare Reviewer — Clinical Safety & PHI Compliance"
  heading = heading.split(/\s+[—–]\s+/)[0].trim();
  const title = IDENTIFIER.test(heading)
    ? humanize(heading.replace(/^@/, ''), namespace)
    : heading && !GENERIC.test(heading)
      ? heading
      : humanize(shortName, namespace);
  return clip(withoutAgentWord(title), 80);
}

// ---------------------------------------------------------------------------
// reading a definition

export interface AssistantParse {
  /** not a definition (no frontmatter, or no name and description): skipped, not refused */
  skip?: boolean;
  meta?: AssistantMeta;
  body: string;
  errors: string[];
  warnings: string[];
}

/** The fields of Claude Code's subagents, and the ones collections add. */
const FIELDS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'color',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'omitClaudeMd',
  'effort',
  'isolation',
  'initialPrompt',
  'vibe',
  'emoji',
]);

/**
 * Frontmatter no YAML reader takes, read field by field the way Claude Code
 * still reads it: a line that starts with a field's name starts that field,
 * and every line up to the next one is its value. Some definitions write a
 * description over many unindented lines, examples and all ("user: …" lines
 * are not fields). Null unless that gives a name and a description.
 */
function readByFields(yaml: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let key: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (!key) return;
    const raw = lines.join('\n');
    let value: unknown;
    try {
      value = (parseYaml(`${key}: ${raw}`) as Record<string, unknown> | null)?.[key];
    } catch {
      value = undefined;
    }
    out[key] = value === undefined || ((key === 'name' || key === 'description') && typeof value !== 'string') ? raw.trim() : value;
  };
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (m && FIELDS.has(m[1])) {
      flush();
      key = m[1];
      lines = [m[2] ?? ''];
    } else if (key) lines.push(line);
  }
  flush();
  return typeof out.name === 'string' && out.name && typeof out.description === 'string' && out.description ? out : null;
}

/** The frontmatter fields read into their own places; the rest stay in `settings` as written. */
const KNOWN = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'color', 'skills', 'mcpServers', 'permissionMode', 'hooks', 'vibe', 'emoji']);

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? clip(v, max) : null);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** MCP servers by name, and those defined in the file with a command to launch. */
function mcpOf(value: unknown): { names: string[]; launches: string[] } {
  const names: string[] = [];
  const launches: string[] = [];
  const add = (name: string, config: unknown) => {
    names.push(name);
    if (config && typeof config === 'object' && typeof (config as { command?: unknown }).command === 'string') launches.push(name);
  };
  if (typeof value === 'string') for (const n of toolList(value)) add(n, null);
  else if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') add(v.trim(), null);
      else if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) add(k, c);
    }
  } else if (value && typeof value === 'object') for (const [k, c] of Object.entries(value)) add(k, c);
  return { names: uniq(names.filter(Boolean)).slice(0, 50), launches: uniq(launches) };
}

/** Skills by name, as a definition lists them (some write a path to the skill's folder). */
function skillsOf(value: unknown): string[] {
  const list = typeof value === 'string' ? toolList(value) : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return uniq(list.map((s) => s.trim()).filter(Boolean)).slice(0, 50);
}

/**
 * Read an assistant's definition. `file` is its file's name, `plugin` the
 * plugin it comes in, if any. Frontmatter is read the way Claude Code reads
 * it, values that are not valid YAML as written included (as text). A file
 * without a frontmatter name and description is no definition (a README, a
 * page of documentation) and is skipped; one whose frontmatter cannot be read
 * at all, or whose name Claude Code would refuse, is refused.
 */
export function parseAssistant(content: string, file: string, plugin: string | null): AssistantParse {
  const warnings: string[] = [];
  const fm = splitFrontmatter(content);
  if (!fm || !/^name\s*:/m.test(fm.yaml) || !/^description\s*:/m.test(fm.yaml)) return { skip: true, body: fm?.body ?? content, errors: [], warnings };
  let data: unknown;
  try {
    data = parseYaml(fm.yaml);
  } catch {
    const loose = quoteLooseValues(fm.yaml);
    try {
      if (loose === null) throw new Error('not loose');
      data = parseYaml(loose);
      warnings.push('frontmatter_unquoted');
    } catch {
      data = readByFields(fm.yaml);
      if (!data) return { body: fm.body, errors: ['frontmatter_invalid'], warnings };
      warnings.push('frontmatter_loose');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { body: fm.body, errors: ['frontmatter_invalid'], warnings };
  const d = data as Record<string, unknown>;
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  const description = typeof d.description === 'string' ? d.description.trim() : '';
  if (!name || !description) return { skip: true, body: fm.body, errors: [], warnings };

  const errors: string[] = [];
  // what Claude Code itself takes as a name
  if (name.length > 256 || name.includes(':') || name.startsWith('-')) errors.push('name_invalid');
  if (!fm.body.trim()) errors.push('body_missing');
  if (new TextEncoder().encode(fm.body).length > LIMITS.textBytes) errors.push('body_too_large');
  if (errors.length) return { body: fm.body, errors, warnings };

  const { text: role, examples } = splitExamples(description);
  let tools = toolsOf(d.tools) ?? null;
  if (tools?.includes('*')) tools = null;
  const mcp = mcpOf(d.mcpServers);
  const hooks = d.hooks !== undefined && d.hooks !== null && (typeof d.hooks !== 'object' || Object.keys(d.hooks as object).length > 0);
  const meta: AssistantMeta = {
    name,
    description: clip(role, 2000),
    tools,
    disallowedTools: toolsOf(d.disallowedTools) ?? [],
    model: text(d.model, 80),
    color: colorOf(d.color),
    skills: skillsOf(d.skills),
    mcpServers: mcp.names,
    mcpLaunches: mcp.launches,
    permissionMode: text(d.permissionMode, 40),
    hooks,
    vibe: text(d.vibe, 200),
    emoji: text(d.emoji, 16),
    starters: startersOf(fm.body, examples),
    examples: examples.slice(0, 6),
    settings: Object.fromEntries(Object.entries(d).filter(([k]) => !KNOWN.has(k))),
    file,
    plugin,
  };
  return { meta, body: fm.body, errors: [], warnings };
}

/** What a definition is compared by: its body, apart from spacing. Copies a repository makes for its plugins differ only in their names. */
export const bodyKey = (body: string) => body.normalize('NFC').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// checks and what it needs

/**
 * The checks that read a definition's frontmatter (docs: harness-assistants.md,
 * section 3): a permission mode that skips the agent's confirmations, hooks
 * that run commands, and MCP servers it launches itself. Codeg leaves these
 * out when it installs one, unless the user agrees to keep them.
 */
export function assistantFindings(meta: AssistantMeta): Finding[] {
  const out: Finding[] = [];
  const path = meta.file;
  const mode = meta.permissionMode?.toLowerCase();
  if (mode === 'bypasspermissions') out.push({ check: 'skips_confirmation', severity: 'medium', path });
  else if (mode === 'acceptedits' || mode === 'auto') out.push({ check: 'auto_approves', severity: 'low', path });
  if (meta.hooks) out.push({ check: 'runs_hooks', severity: 'medium', path });
  if (meta.mcpLaunches.length) out.push({ check: 'launches_mcp', severity: 'medium', path });
  return out;
}

/** a tool that hands work to something else of a plugin, by its plugin's name: `Agent(security:scanner)` */
const DELEGATES = /^(Agent|Task|Skill|Workflow|SlashCommand)\((.*)\)$/s;
const namespaced = (s: string) => /^[a-z0-9][\w.-]*:[\w.-]/i.test(s.trim());

/**
 * It cannot work without the rest of its plugin: its body uses the plugin's
 * root folder, or it hands work to the plugin's own agents, skills or
 * workflows by their plugin's name.
 */
export function needsPlugin(meta: AssistantMeta, body: string): boolean {
  if (/CLAUDE_PLUGIN_ROOT/.test(body)) return true;
  if (meta.skills.some(namespaced)) return true;
  return (meta.tools ?? []).some((t) => {
    const m = DELEGATES.exec(t.trim());
    return !!m && m[2].split(',').some(namespaced);
  });
}

/**
 * What an assistant needs: the tools it lists (declared; all of them, `*`,
 * when it lists none), beside what its body shows (hosts, credentials, paths),
 * and the commands its hooks and its own MCP servers run.
 */
export function assistantPermissions(files: PackageFile[], meta: AssistantMeta): PermissionProfile {
  const profile = skillPermissions(files, meta.tools ?? undefined);
  const runs = new Set(profile.detected.runsCode);
  if (meta.hooks) runs.add('shell');
  for (const name of meta.mcpLaunches) runs.add(`mcp:${name}`);
  return {
    declared: meta.tools ? { tools: meta.tools } : {},
    detected: { ...profile.detected, runsCode: [...runs].sort(), tools: meta.tools ?? ['*'] },
  };
}

/**
 * What an assistant does, as its card says it: its description without the
 * sentences that tell the main session, in capitals, when to call it ("Use
 * PROACTIVELY …", "MUST BE USED …"), where enough is left to say it. The
 * item's own page keeps the description whole.
 */
export function roleText(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !/\b(?:PROACTIVELY|IMMEDIATELY|MUST BE USED|MUST USE|ALWAYS USE)\b/.test(s)).join(' ').trim();
  return kept.length >= 40 ? kept : text;
}

/** What an assistant's card shows. */
export function assistantCard(meta: AssistantMeta, alsoIn: string[] = []): StoredAssistantCard {
  return {
    role: clip(meta.description, 280),
    model: meta.model,
    tools: meta.tools,
    access: accessOf(meta.tools, meta.disallowedTools),
    color: meta.color,
    skills: meta.skills.length,
    mcpServers: meta.mcpServers.length,
    plugin: meta.plugin,
    alsoIn,
  };
}
