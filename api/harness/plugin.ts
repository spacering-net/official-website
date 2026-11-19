import { asText, sha256, treeHash, type PackageFile } from './files';
import { LIMITS } from './limits';
import type { StoredPluginCard } from './model';
import { isPublicHttps } from './mcp';
import type { Finding } from './scan/content';
import { scanStructure } from './scan/content';
import { applyRules, type Rule } from './scan/rules';
import { parseYaml, splitFrontmatter } from './skill';

/**
 * Plugins (docs/harness-plugins.md, section 3): what a repository declares as
 * a plugin, read from its manifests, and whether it has to be used whole.
 * Pure functions over the repository's file list and a plugin folder's files;
 * the importer (importers/github.ts) downloads, the store saves.
 *
 * A plugin is used whole when it runs things on its own once installed
 * (hooks, code a host loads, MCP and LSP servers, monitors, a `bin/` folder),
 * or when its members name one another (`superpowers:brainstorming`, a
 * frontmatter `skills: [agenthub:agenthub]`, the plugin's root folder in a
 * path), or when its source says so. Otherwise its skills and assistants stay
 * items of their own; the plugin only lends them its version.
 */

export type Host = 'claude' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'opencode' | 'pi' | 'kimi' | 'antigravity' | 'devin' | 'hermes' | 'muse' | 'agent-plugins';

/** Marketplaces, read before the download: they say where a repository's plugins are. */
export const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'] as const;
/** A repository that is itself a plugin says so in one of these, at its root. */
const ROOT_MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json'];

/** Each host's manifest, by its path in the plugin folder. */
const JSON_MANIFESTS: [Host, string][] = [
  ['claude', '.claude-plugin/plugin.json'],
  ['codex', '.codex-plugin/plugin.json'],
  ['cursor', '.cursor-plugin/plugin.json'],
  ['gemini', 'gemini-extension.json'],
  ['copilot', '.github/plugin/plugin.json'],
  ['copilot', '.plugin/plugin.json'],
  ['kimi', '.kimi-plugin/plugin.json'],
  ['antigravity', '.antigravity-plugin/plugin.json'],
  ['devin', '.devin-plugin/plugin.json'],
  ['muse', '.muse-plugin/plugin.json'],
  ['agent-plugins', 'plugin.json'],
];
const KNOWN_MANIFEST = new Set([...JSON_MANIFESTS.map(([, p]) => p), '.hermes-plugin/plugin.yaml', '.hermes-plugin/plugin.yml']);

/** A plugin a repository declares. */
export interface PluginSpec {
  /** its marketplace name; null for a repository that is one plugin (named by its manifest) */
  name: string | null;
  /** its folder ('' for the repository's root) */
  root: string;
  /** its place in the marketplace: a member two plugins share goes to the first */
  order: number;
  /** what the marketplace says of it (with `strict: false`, all there is of its manifest) */
  entry: Record<string, unknown> | null;
  /** the skill folders the entry lists, from the repository's root; null: all of them */
  skills: string[] | null;
}

export interface PluginProblem {
  plugin: string;
  reason: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A path inside a folder, normalized; null when it leaves the folder, is absolute or is a URL. */
export function within(base: string, rel: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return null;
  const parts = base ? base.split('/') : [];
  for (const p of rel.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') return null;
    parts.push(p);
  }
  return parts.join('/');
}

const parseJson = (text: string | undefined | null): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The files to read before the download, of those the repository has: its marketplaces, and a root package.json that may be a Pi package. */
export function filesToReadFirst(paths: Set<string>): string[] {
  const out: string[] = MARKETPLACES.filter((p) => paths.has(p));
  if (!out.length && !ROOT_MANIFESTS.some((p) => paths.has(p)) && paths.has('package.json')) out.push('package.json');
  return out;
}

/**
 * The plugins a repository declares (section 3, step 1): each plugin of its
 * marketplaces whose source is a folder of this repository (others are
 * imported from their own), Claude Code's marketplace first; else, when the
 * repository is one plugin, its root. `read`: what filesToReadFirst named.
 */
export function pluginSpecs(paths: Set<string>, read: Map<string, string>): { specs: PluginSpec[]; problems: PluginProblem[] } {
  const specs: PluginSpec[] = [];
  const problems: PluginProblem[] = [];
  const has = (root: string) => (root ? [...paths].some((p) => p.startsWith(`${root}/`)) : paths.size > 0);
  const add = (name: string, rawRoot: string, entry: Record<string, unknown>) => {
    if (specs.some((s) => s.name === name)) return;
    const root = within('', rawRoot);
    if (root === null) return problems.push({ plugin: name, reason: 'outside_repository' });
    if (!has(root)) return problems.push({ plugin: name, reason: 'missing_folder' });
    let skills: string[] | null = null;
    if (Array.isArray(entry.skills)) {
      skills = [];
      for (const s of entry.skills) {
        const dir = typeof s === 'string' ? within(root, s) : null;
        if (dir === null) return problems.push({ plugin: name, reason: 'outside_plugin' });
        skills.push(dir);
      }
    }
    specs.push({ name, root, order: specs.length, entry, skills });
  };
  const claude = parseJson(read.get('.claude-plugin/marketplace.json'));
  if (isObj(claude) && Array.isArray(claude.plugins)) {
    for (const e of claude.plugins) {
      const name = isObj(e) ? str(e.name, 64) : null;
      if (!name || !isObj(e)) continue;
      // a folder of this repository; a git or URL source is imported from where it lives
      if (typeof e.source === 'string') add(name, e.source, e);
    }
  }
  const codex = parseJson(read.get('.agents/plugins/marketplace.json'));
  if (isObj(codex) && Array.isArray(codex.plugins)) {
    for (const e of codex.plugins) {
      const name = isObj(e) ? str(e.name, 64) : null;
      if (!name || !isObj(e) || !isObj(e.source)) continue;
      const s = e.source;
      const rel = s.source === 'local' ? s.path : s.source === 'url' && typeof s.url === 'string' && /^\.{1,2}(\/|$)/.test(s.url) ? s.url : null;
      if (typeof rel === 'string') add(name, rel, e);
    }
  }
  if (!specs.length && !problems.length) {
    const pkg = parseJson(read.get('package.json'));
    if (ROOT_MANIFESTS.some((p) => paths.has(p)) || (isObj(pkg) && isObj(pkg.pi))) specs.push({ name: null, root: '', order: 0, entry: null, skills: null });
  }
  return { specs, problems };
}

/**
 * Why a plugin's folder cannot be taken as one package (section 3, step 6),
 * from the repository's tree: more files or bytes than a package may have,
 * or a link (one may point anywhere). Null when it can.
 */
export function folderProblem(root: string, tree: { path: string; type: string; size?: number; mode?: string }[]): string | null {
  const inside = tree.filter((e) => e.type === 'blob' && (!root || e.path.startsWith(`${root}/`)));
  if (inside.some((e) => e.mode === '120000')) return 'link';
  if (inside.length > LIMITS.files) return 'too_many_files';
  if (inside.reduce((n, e) => n + (e.size ?? 0), 0) > LIMITS.totalBytes) return 'too_large';
  if (inside.some((e) => (e.size ?? 0) > LIMITS.fileBytes)) return 'file_too_large';
  return null;
}

// ---------------------------------------------------------------------------
// what a plugin holds

export interface PluginComponent {
  kind: 'skill' | 'assistant';
  /** as its definition names it */
  name: string;
  /** its folder (a skill) or file (an assistant), in the plugin */
  path: string;
  /** its files' tree hash: two versions' tell which members changed */
  treeSha256: string;
  title: string | null;
  summary: string | null;
}

/** Something that runs once the plugin is installed, without the user or the agent calling it. */
export interface AutorunPart {
  host: Host;
  type: 'hook' | 'code' | 'mcp' | 'lsp' | 'monitor' | 'bin';
  /** the file that declares it (or is it, for code) */
  path: string;
  /** a hook's event, a server's name */
  event?: string;
  name?: string;
  /** what it runs, as written */
  command?: string;
}

export interface HostContent {
  host: Host;
  /** its manifest, in the plugin ('' when only the marketplace's entry describes it) */
  manifest: string;
  skills: number;
  agents: number;
  commands: number;
  hooks: number;
  mcp: number;
  code: number;
}

/** What a plugin version keeps of its plugin (item_versions.metadata.plugin). */
export interface PluginDescriptor {
  name: string;
  version: string | null;
  title: string | null;
  description: string | null;
  hosts: HostContent[];
  /** manifests of hosts Harness does not know yet */
  unknownManifests: string[];
  components: PluginComponent[];
  autorun: AutorunPart[];
  /** the files that run on their own, with the manifests and the files their commands name */
  autorunFiles: string[];
  /** MCP servers whose package is not pinned to an exact version, or whose address is not public https */
  mcpUnpinned: string[];
  /** the npm and PyPI packages its MCP servers fetch, as pinned (checked as an MCP server's are) */
  packages: { registryType: 'npm' | 'pypi'; identifier: string; version: string | null }[];
  /** why it cannot be taken as a package (a manifest that does not read, a path it names out of its folder or missing) */
  problems: string[];
  /** used whole, and why */
  whole: boolean;
  why: ('autorun' | 'depends' | 'config')[];
  /** what Codeg asks the user to agree to again when it changes (section 6) */
  execSha256: string;
}

/** What a plugin's card shows (items.card), from its descriptor. */
export const pluginCardOf = (d: PluginDescriptor): StoredPluginCard => ({
  skills: d.components.filter((c) => c.kind === 'skill').length,
  assistants: d.components.filter((c) => c.kind === 'assistant').length,
  hosts: d.hosts.map((h) => h.host),
  autorun: d.autorun.length > 0,
});

const ROOT_VARS = /\$\{?(?:CLAUDE_PLUGIN_ROOT|CURSOR_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT|PLUGIN_DIR|extensionPath)\}?/;

/** The files a command names: by a path from the plugin root (or its variable), and then by bare names beside the first. */
function namedFiles(command: string, base: string, files: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of command.split(/[\s"'=;|&()]+/)) {
    const token = raw.replace(ROOT_VARS, '').replace(/^\/+/, '');
    if (!token) continue;
    const direct = within('', token);
    const beside = out.length ? within(out[0].includes('/') ? out[0].slice(0, out[0].lastIndexOf('/')) : '', token) : null;
    const fromBase = within(base, token);
    for (const p of [direct, fromBase, beside]) {
      if (p !== null && files.has(p) && !out.includes(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

/** Hook declarations in any of the hosts' shapes: `{hooks: {Event: [{matcher, hooks: [{command}]}]}}` or `{hooks: {event: [{command}]}}`. */
function hookParts(host: Host, declared: unknown, path: string): AutorunPart[] {
  const events = isObj(declared) && isObj(declared.hooks) ? declared.hooks : declared;
  if (!isObj(events)) return [];
  const out: AutorunPart[] = [];
  for (const [event, list] of Object.entries(events)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isObj(item)) continue;
      const handlers = Array.isArray(item.hooks) ? item.hooks : [item];
      for (const h of handlers) {
        if (!isObj(h)) continue;
        out.push({ host, type: 'hook', path, event, command: str(h.command, 1000) ?? str(h.prompt, 200) ?? (typeof h.type === 'string' ? h.type : undefined) });
      }
    }
  }
  return out;
}

/** Commands that fetch a package to run it, and how each names it. */
const FETCHERS: Record<string, { after?: string; pinned: (spec: string) => boolean }> = {
  npx: { pinned: (s) => /^(@[^/@\s]+\/)?[^@\s]+@v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(s) },
  npm: { after: 'exec', pinned: (s) => /^(@[^/@\s]+\/)?[^@\s]+@v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(s) },
  bun: { after: 'x', pinned: (s) => /^(@[^/@\s]+\/)?[^@\s]+@v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(s) },
  bunx: { pinned: (s) => /^(@[^/@\s]+\/)?[^@\s]+@v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(s) },
  pnpm: { after: 'dlx', pinned: (s) => /^(@[^/@\s]+\/)?[^@\s]+@v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(s) },
  yarn: { after: 'dlx', pinned: (s) => /^(@[^/@\s]+\/)?[^@\s]+@v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(s) },
  uvx: { pinned: (s) => /==\s*\d+(\.\d+)*$/.test(s) },
  pipx: { after: 'run', pinned: (s) => /==\s*\d+(\.\d+)*$/.test(s) },
  docker: { after: 'run', pinned: (s) => /@sha256:[0-9a-f]{64}$/.test(s) },
};
/**
 * The options each fetching tool may have before what it runs, in the plain forms read here: with a value
 * (`name value` or `name=value`), and without. Any other option, or for npm exec any option after the
 * first word but before `--`, makes the launch unclear: it is then taken as not pinned, so a launch whose
 * package Harness cannot be sure of is never installed whole (fail closed, not an emulation of each CLI).
 */
const OPTIONS: Record<string, { value: Set<string>; bare: Set<string> }> = {
  npm: { value: new Set(['-p', '--package']), bare: new Set(['-y', '--yes', '-q', '--quiet', '--silent']) },
  npx: { value: new Set(['-p', '--package']), bare: new Set(['-y', '--yes', '-q', '--quiet', '--silent']) },
  bunx: { value: new Set(['-p', '--package']), bare: new Set(['--bun', '--silent']) },
  bun: { value: new Set(['-p', '--package']), bare: new Set(['--bun', '--silent']) },
  pnpm: { value: new Set(['--package']), bare: new Set(['--silent', '-s']) },
  yarn: { value: new Set(['-p', '--package']), bare: new Set(['-q', '--quiet']) },
  uvx: { value: new Set(['--from', '--with', '--python']), bare: new Set(['-q', '--quiet']) },
  pipx: { value: new Set(['--spec', '--python']), bare: new Set(['-q', '--quiet']) },
  docker: {
    value: new Set(['-e', '--env', '-v', '--volume', '--name', '--network', '-w', '--workdir', '-u', '--user', '--entrypoint', '-l', '--label', '--mount', '--env-file']),
    bare: new Set(['-i', '-t', '-it', '-ti', '--rm', '--init', '--interactive', '--tty']),
  },
};
/** options naming a package the command fetches */
const PACKAGE_FLAGS = new Set(['-p', '--package', '--from', '--with', '--spec']);

/** What a launch command fetches to run: the tool, every package it names, and whether that is all clear. */
function fetched(cfg: Record<string, unknown>): { tool: string; specs: string[]; clear: boolean } | null {
  if (typeof cfg.command !== 'string') return null;
  const command = cfg.command.trim().split(/\s+/);
  const args = [...command.slice(1), ...(Array.isArray(cfg.args) ? cfg.args.map(String) : [])];
  const tool = command[0].split(/[\\/]/).pop()!.replace(/\.(cmd|exe)$/i, '');
  const f = FETCHERS[tool];
  if (!f) return null;
  let rest = args;
  if (f.after) {
    const at = rest.indexOf(f.after);
    if (at < 0) return null;
    // options of the tool before its subcommand (npm --yes exec …) are not read: unclear
    if (rest.slice(0, at).length) return { tool, specs: [], clear: false };
    rest = rest.slice(at + 1);
  }
  const options = OPTIONS[tool];
  const named: string[] = [];
  const withs: string[] = [];
  let from: string | undefined;
  let positional: string | undefined;
  let clear = true;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      // only npm exec is read past `--` (to the command it runs); any other tool's reading is not imitated
      if (tool !== 'npm' && positional === undefined) clear = false;
      positional ??= rest[i + 1];
      break;
    }
    if (positional !== undefined) {
      // npx and the rest hand everything after the first word to it; npm exec reads options up to `--`
      if (tool === 'npm' && a.startsWith('-')) clear = false;
      if (tool !== 'npm') break;
      continue;
    }
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const flag = eq > 0 ? a.slice(0, eq) : a;
      if (options.bare.has(a)) continue;
      if (!options.value.has(flag)) {
        clear = false;
        break;
      }
      const value = eq > 0 ? a.slice(eq + 1) : rest[++i];
      if (value === undefined || value.startsWith('-')) {
        clear = false;
        break;
      }
      if (PACKAGE_FLAGS.has(flag)) {
        if (flag === '--with') withs.push(value);
        else if (flag === '--from' || flag === '--spec') from = value;
        else named.push(value);
      }
      continue;
    }
    positional = a;
    if (tool !== 'npm') break;
  }
  // uvx and pipx run the package --from (or --spec) names, else the first word, with --with ones beside it;
  // the others run the first word from the packages --package names, when it names any, else fetch it
  const main = tool === 'uvx' || tool === 'pipx' ? (from ?? positional) : named.length ? undefined : positional;
  return { tool, specs: [...named, ...(main ? [main] : []), ...withs], clear };
}

/**
 * Whether an MCP server's configuration pins what it runs (section 6): a
 * remote one at a public https address; every package fetched to run (npx,
 * uvx, docker …) at an exact version or digest. A command from the plugin
 * itself, or one the user has installed, fetches nothing.
 */
export function mcpPinned(cfg: Record<string, unknown>): boolean {
  if (typeof cfg.url === 'string') return isPublicHttps(cfg.url);
  const f = fetched(cfg);
  if (!f) return true;
  return f.clear && f.specs.length > 0 && f.specs.every((spec) => FETCHERS[f.tool].pinned(spec));
}

/** The packages an MCP server fetches to run, as npm or PyPI name them, with the version each pins (null: none). */
export function mcpPackages(cfg: Record<string, unknown>): { registryType: 'npm' | 'pypi'; identifier: string; version: string | null }[] {
  const f = fetched(cfg);
  if (!f) return [];
  const registry = ['npx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun'].includes(f.tool) ? 'npm' : ['uvx', 'pipx'].includes(f.tool) ? 'pypi' : null;
  if (!registry) return [];
  const out: { registryType: 'npm' | 'pypi'; identifier: string; version: string | null }[] = [];
  for (const spec of f.specs) {
    if (/^[.~/]|:\/\//.test(spec)) continue;
    if (registry === 'npm') {
      const m = /^((?:@[^/@\s]+\/)?[^@\s]+)(?:@(.+))?$/.exec(spec);
      if (m) out.push({ registryType: 'npm', identifier: m[1], version: m[2] && /^v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(m[2]) ? m[2].replace(/^v/, '') : null });
    } else {
      const m = /^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?(?:==\s*([\w.!+-]+))?$/.exec(spec);
      if (m) out.push({ registryType: 'pypi', identifier: m[1], version: m[2] ?? null });
    }
  }
  return out;
}

function mcpParts(host: Host, type: 'mcp' | 'lsp', declared: unknown, path: string, unpinned: Set<string>, packages?: Map<string, ReturnType<typeof mcpPackages>[number]>): AutorunPart[] {
  const key = type === 'mcp' ? 'mcpServers' : 'lspServers';
  const servers = isObj(declared) && isObj(declared[key]) ? declared[key] : declared;
  if (!isObj(servers)) return [];
  const out: AutorunPart[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!isObj(cfg)) continue;
    const command = typeof cfg.url === 'string' ? cfg.url : [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].filter((x) => typeof x === 'string').join(' ');
    out.push({ host, type, path, name: name.slice(0, 100), command: command.slice(0, 1000) || undefined });
    if (type === 'mcp' && !mcpPinned(cfg)) unpinned.add(name.slice(0, 100));
    if (type === 'mcp' && packages) for (const pkg of mcpPackages(cfg)) packages.set(`${pkg.registryType}:${pkg.identifier}@${pkg.version}`, pkg);
  }
  return out;
}

const IMAGE = (data: Uint8Array) => {
  const is = (...sig: number[]) => sig.every((x, i) => data[i] === x);
  return is(0x89, 0x50, 0x4e, 0x47) || is(0xff, 0xd8, 0xff) || is(0x47, 0x49, 0x46, 0x38) || (is(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45);
};

/** The hash Codeg compares to ask again (section 6): what runs on its own, the manifests, and every file but Markdown, plain text and pictures. */
async function execHash(files: PackageFile[], autorunFiles: Set<string>, manifests: Set<string>): Promise<string> {
  const lines: string[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const plain = /\.(md|markdown|txt)$/i.test(f.path) || IMAGE(f.data);
    if (plain && !autorunFiles.has(f.path) && !manifests.has(f.path)) continue;
    lines.push(`${f.executable ? 'x' : '-'} ${await sha256(f.data)} ${f.path}`);
  }
  return sha256(lines.join('\n'));
}

/** Tests and samples, and folders an agent keeps its own copies in: not members. */
const NOT_MEMBERS = /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|examples?|samples?)\/|(^|\/)\.[^/]+\//i;

/** Folders that hold one skill each (outermost SKILL.md folders), in a plugin. */
const skillFolders = (paths: string[]) => {
  const dirs = paths.filter((p) => /(^|\/)SKILL\.md$/.test(p) && !NOT_MEMBERS.test(p)).map((p) => p.replace(/\/?SKILL\.md$/, ''));
  return dirs.filter((d) => !dirs.some((o) => o !== d && (o === '' || d.startsWith(`${o}/`)))).sort();
};
const NOT_DEFINITION = /(^|\/)(README|CHANGELOG|CONTRIBUTING|LICEN[CS]E|index|(?:[\w-]*[-_.])?template)\.(md|markdown)$/i;

function frontmatterOf(text: string): Record<string, unknown> {
  const fm = splitFrontmatter(text);
  if (!fm) return {};
  try {
    const v = parseYaml(fm.yaml);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Read a plugin from its folder's files (paths from the folder): each host's
 * manifest and what it brings, its members, what runs on its own, and whether
 * it is used whole. `override`: the source's own word ('whole' or 'split').
 */
export async function readPlugin(spec: PluginSpec, files: PackageFile[], override?: 'whole' | 'split'): Promise<PluginDescriptor> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const paths = new Set(byPath.keys());
  const text = (p: string) => {
    const f = byPath.get(p);
    return f ? asText(f.data) : null;
  };
  const json = (p: string) => parseJson(text(p));
  const parts: AutorunPart[] = [];
  const unpinned = new Set<string>();
  const hosts: HostContent[] = [];
  const manifests = new Set<string>();
  const declaredFiles = new Set<string>();
  const problems = new Set<string>();
  const packages = new Map<string, ReturnType<typeof mcpPackages>[number]>();

  /** a field that names a file of the plugin, or holds the declaration itself */
  const declared = (value: unknown, cb: (v: unknown, path: string) => void, path: string) => {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === 'string') {
        // a file the host reads it from: inside the plugin, or the host would read beyond what was checked
        const p = within('', v);
        if (p === null) problems.add('outside_plugin');
        else if (!paths.has(p)) problems.add('missing_file');
        else {
          declaredFiles.add(p);
          const parsed = json(p);
          if (parsed === null) problems.add('unreadable_manifest');
          cb(parsed, p);
        }
      } else if (isObj(v)) cb(v, path);
    }
  };
  const count = (host: Host, from: number) => {
    const mine = parts.slice(from);
    return { hooks: mine.filter((p) => p.type === 'hook').length, mcp: mine.filter((p) => p.type === 'mcp').length, code: mine.filter((p) => p.type === 'code').length };
  };
  const dirFiles = (dir: string, re: RegExp) => [...paths].filter((p) => p.startsWith(`${dir}/`) && re.test(p)).length;
  const skills = (spec.skills ? spec.skills.map((s) => (spec.root ? s.slice(spec.root.length + 1) : s)) : skillFolders([...paths])).filter((d) => paths.has(d ? `${d}/SKILL.md` : 'SKILL.md'));

  for (const [host, path] of JSON_MANIFESTS) {
    const own = json(path);
    // a manifest a host would fail to read, or read otherwise than Harness did
    if (paths.has(path) && !isObj(own)) problems.add('unreadable_manifest');
    const isClaude = host === 'claude';
    // Claude Code takes a marketplace entry as the manifest when the plugin has none of its own (strict: false)
    const m = isClaude ? (isObj(own) ? { ...(spec.entry ?? {}), ...own } : spec.entry && (spec.entry.strict === false || !paths.has(path)) ? spec.entry : null) : own;
    if (!isObj(m)) continue;
    if (host === 'agent-plugins' && !(isObj(own) && (own.skills || own.hooks || own.mcpServers || own.agents))) continue;
    if (isObj(own)) manifests.add(path);
    const from = parts.length;
    const hookDefault = host === 'claude' || host === 'codex' || host === 'cursor' || host === 'copilot' ? 'hooks/hooks.json' : null;
    if ('hooks' in m) declared(m.hooks, (v, p) => parts.push(...hookParts(host, v, p)), path);
    else if (hookDefault && paths.has(hookDefault)) {
      declaredFiles.add(hookDefault);
      if (!isObj(json(hookDefault))) problems.add('unreadable_manifest');
      parts.push(...hookParts(host, json(hookDefault), hookDefault));
    }
    if ('mcpServers' in m) declared(m.mcpServers, (v, p) => parts.push(...mcpParts(host, 'mcp', v, p, unpinned, packages)), path);
    else if (host !== 'gemini' && paths.has('.mcp.json') && host !== 'agent-plugins') {
      declaredFiles.add('.mcp.json');
      if (!isObj(json('.mcp.json'))) problems.add('unreadable_manifest');
      parts.push(...mcpParts(host, 'mcp', json('.mcp.json'), '.mcp.json', unpinned, packages));
    }
    if (isClaude) {
      if ('lspServers' in m) declared(m.lspServers, (v, p) => parts.push(...mcpParts(host, 'lsp', v, p, unpinned)), path || '.claude-plugin/marketplace.json');
      else if (paths.has('.lsp.json')) {
        declaredFiles.add('.lsp.json');
        parts.push(...mcpParts(host, 'lsp', json('.lsp.json'), '.lsp.json', unpinned));
      }
      if (m.monitors !== undefined && m.monitors !== null && !(isObj(m.monitors) && !Object.keys(m.monitors).length)) parts.push({ host, type: 'monitor', path });
      for (const p of [...paths].filter((p) => p.startsWith('bin/'))) parts.push({ host, type: 'bin', path: p });
    }
    const counted = count(host, from);
    hosts.push({
      host,
      manifest: isObj(own) ? path : '',
      skills: skills.length,
      agents: dirFiles('agents', /\.md$/i),
      commands: dirFiles('commands', /\.md$/i),
      ...counted,
    });
  }
  // hosts that load code: OpenCode's plugins (and the folder form's root entry), Pi's extensions, Hermes' module
  // OpenCode loads a plugin folder's entry (index.js, or package.json's main) when it is configured as one
  const opencode = [...paths].filter((p) => /^\.opencode\/plugins\/[^/]+\.(js|mjs|cjs|ts)$/.test(p));
  const pkgMain = (() => {
    const v = json('package.json');
    const main = isObj(v) && typeof v.main === 'string' ? within('', v.main) : null;
    return main && paths.has(main) ? main : null;
  })();
  const entries = [...new Set([...(paths.has('index.js') ? ['index.js'] : []), ...(pkgMain ? [pkgMain] : [])])];
  // only for a plugin that says it is one for OpenCode: Codeg installs a plugin natively only for the hosts listed here
  const pkgJson = json('package.json');
  const forOpenCode =
    opencode.length > 0 ||
    [...paths].some((p) => p.startsWith('.opencode/')) ||
    (isObj(pkgJson) && ('opencode' in pkgJson || (Array.isArray(pkgJson.keywords) && pkgJson.keywords.some((k) => typeof k === 'string' && /opencode/i.test(k)))));
  if (forOpenCode && (opencode.length || (paths.has('package.json') && entries.length))) {
    const from = parts.length;
    for (const p of [...new Set([...opencode, ...entries])]) parts.push({ host: 'opencode', type: 'code', path: p });
    hosts.push({ host: 'opencode', manifest: '', skills: skills.length, agents: 0, commands: 0, ...count('opencode', from) });
  }
  const pkg = json('package.json');
  if (isObj(pkg) && isObj(pkg.pi)) {
    manifests.add('package.json');
    const from = parts.length;
    for (const e of Array.isArray(pkg.pi.extensions) ? pkg.pi.extensions : []) {
      const p = typeof e === 'string' ? within('', e) : null;
      if (p !== null && paths.has(p)) parts.push({ host: 'pi', type: 'code', path: p });
    }
    hosts.push({ host: 'pi', manifest: 'package.json', skills: skills.length, agents: 0, commands: 0, ...count('pi', from) });
  }
  const hermes = ['.hermes-plugin/plugin.yaml', '.hermes-plugin/plugin.yml'].find((p) => paths.has(p));
  if (hermes) {
    manifests.add(hermes);
    const from = parts.length;
    for (const p of [...paths].filter((p) => /^\.hermes-plugin\/[^/]+\.py$/.test(p))) parts.push({ host: 'hermes', type: 'code', path: p });
    hosts.push({ host: 'hermes', manifest: hermes, skills: skills.length, agents: 0, commands: 0, ...count('hermes', from) });
  }
  const unknownManifests = [...paths].filter((p) => /^\.[a-z0-9-]+-plugin\/plugin\.(json|ya?ml)$/i.test(p) && !KNOWN_MANIFEST.has(p)).sort();

  // the files what runs on its own names: a hook's script and the scripts it runs, a server's entry
  const autorunFiles = new Set<string>([...manifests, ...declaredFiles]);
  for (const p of parts) {
    if (p.type === 'code' || p.type === 'bin') autorunFiles.add(p.path);
    if (p.command) for (const f of namedFiles(p.command, p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '', paths)) autorunFiles.add(f);
  }

  // members, and whether they name one another
  const components: PluginComponent[] = [];
  for (const dir of skills) {
    const own = files.filter((f) => (dir ? f.path.startsWith(`${dir}/`) : true));
    const fm = frontmatterOf(text(dir ? `${dir}/SKILL.md` : 'SKILL.md') ?? '');
    components.push({
      kind: 'skill',
      name: str(fm.name, 64) ?? (dir.split('/').pop() || spec.name || 'skill'),
      path: dir,
      treeSha256: await treeHash(own.map((f) => ({ ...f, path: dir ? f.path.slice(dir.length + 1) : f.path }))),
      title: null,
      summary: str(fm.description, 1024),
    });
  }
  for (const p of [...paths].filter((p) => /(^|\/)agents\/[^/]+\.(md|markdown)$/i.test(p) && !NOT_DEFINITION.test(p) && !NOT_MEMBERS.test(p) && !skills.some((d) => d === '' || p.startsWith(`${d}/`))).sort()) {
    const fm = frontmatterOf(text(p) ?? '');
    const name = str(fm.name, 64);
    if (!name || !str(fm.description)) continue;
    components.push({ kind: 'assistant', name, path: p, treeSha256: await treeHash([{ ...byPath.get(p)!, path: p.split('/').pop()! }]), title: null, summary: str(fm.description, 1024) });
  }
  const names = [...new Set([spec.name, ...JSON_MANIFESTS.map(([, path]) => (isObj(json(path)) ? str((json(path) as Record<string, unknown>).name, 64) : null))].filter((n): n is string => !!n))];
  const memberNames = new Set(components.map((c) => c.name.toLowerCase()));
  let depends = false;
  for (const c of components) {
    if (depends) break;
    const own = c.kind === 'skill' ? files.filter((f) => (c.path ? f.path.startsWith(`${c.path}/`) : true)) : [byPath.get(c.path)!];
    for (const f of own) {
      const t = asText(f.data);
      if (t === null) continue;
      if (ROOT_VARS.test(t)) {
        depends = true;
        break;
      }
      for (const n of names) {
        const re = new RegExp(`(?<![\\w.-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([a-z0-9][\\w.-]*)`, 'gi');
        for (const m of t.matchAll(re)) {
          const target = m[1].toLowerCase().replace(/[.-]+$/, '');
          if (target !== c.name.toLowerCase() && memberNames.has(target)) {
            depends = true;
            break;
          }
        }
        if (depends) break;
      }
      if (depends) break;
    }
  }

  const why: PluginDescriptor['why'] = [];
  if (parts.length) why.push('autorun');
  if (depends) why.push('depends');
  if (override === 'whole') why.push('config');
  const whole = components.length > 0 && override !== 'split' && why.length > 0;

  const manifestOf = (path: string) => {
    const v = json(path);
    return isObj(v) ? v : {};
  };
  const claudeM = { ...(spec.entry ?? {}), ...manifestOf('.claude-plugin/plugin.json') };
  const codexM = manifestOf('.codex-plugin/plugin.json');
  const iface = isObj(codexM.interface) ? codexM.interface : {};
  const version =
    str(manifestOf('.claude-plugin/plugin.json').version, 64) ??
    str(codexM.version, 64) ??
    (isObj(pkg) ? str(pkg.version, 64) : null) ??
    str(spec.entry?.version, 64) ??
    JSON_MANIFESTS.map(([, p]) => str(manifestOf(p).version, 64)).find(Boolean) ??
    null;
  return {
    name: names[0] ?? (spec.root.split('/').pop() || 'plugin'),
    version,
    title: str(iface.displayName, 100) ?? str(claudeM.displayName, 100) ?? str(claudeM.name, 100),
    description: str(iface.shortDescription, 1024) ?? str(claudeM.description, 1024) ?? str(codexM.description, 1024),
    hosts,
    unknownManifests,
    components,
    autorun: parts,
    autorunFiles: [...autorunFiles].sort(),
    mcpUnpinned: [...unpinned].sort(),
    packages: [...packages.values()],
    problems: [...problems].sort(),
    whole,
    why,
    execSha256: await execHash(files, autorunFiles, manifests),
  };
}

/**
 * A plugin's findings (section 6): the structural checks and the rules on
 * every file as for any package, and every rule, whatever its scope, on what
 * runs on its own and what that names.
 */
export function pluginFindings(files: PackageFile[], descriptor: Pick<PluginDescriptor, 'autorunFiles'>, rules: Rule[]): Finding[] {
  const out = [...scanStructure(files), ...applyRules(rules, files)];
  const seen = new Set(out.map((f) => `${f.rule}|${f.path}|${f.line}`));
  const auto = new Set(descriptor.autorunFiles);
  for (const f of applyRules(rules.map((r) => ({ ...r, scope: 'all' as const })), files.filter((f) => auto.has(f.path)))) {
    const key = `${f.rule}|${f.path}|${f.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/** The hooks and code a plugin brings, as its permission profile lists them (section 6). */
export function pluginPermissionLines(d: Pick<PluginDescriptor, 'autorun'>): { hooks: string[]; code: string[]; servers: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs)].slice(0, 50);
  return {
    hooks: uniq(d.autorun.filter((p) => p.type === 'hook').map((p) => `${p.host} · ${p.event ?? ''} · ${p.command ?? p.path}`)),
    code: uniq(d.autorun.filter((p) => p.type === 'code' || p.type === 'bin').map((p) => p.path)),
    servers: uniq(d.autorun.filter((p) => p.type === 'mcp' || p.type === 'lsp' || p.type === 'monitor').map((p) => `${p.type}:${p.name ?? p.path}`)),
  };
}
