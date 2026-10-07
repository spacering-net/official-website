import { asText, type PackageFile } from '../files';

/**
 * What an item needs (docs: section 3, the permission profile). Each version
 * keeps what its publisher declared beside what the checks detected; the
 * page shows both and marks where they disagree.
 */
export interface Permissions {
  /** languages and runtimes it runs: python, node, shell, binary, docker, ... */
  runsCode: string[];
  /** what it installs: package managers it calls, packages it pulls */
  installs: string[];
  /** packages that run scripts as they install (npm), or build from source (Python) */
  installScripts: string[];
  /** hosts it talks to */
  network: string[];
  /** credentials it needs: environment variables, headers */
  secrets: string[];
  /** places outside the workspace it reads or writes */
  paths: string[];
  /** agent tools it asks for (allowed-tools) */
  tools: string[];
}

export interface PermissionProfile {
  declared: Partial<Permissions>;
  detected: Permissions;
}

export const emptyPermissions = (): Permissions => ({ runsCode: [], installs: [], installScripts: [], network: [], secrets: [], paths: [], tools: [] });

const RUNTIME_OF: [RegExp, string][] = [
  [/\.py$/i, 'python'],
  [/\.(js|mjs|cjs|ts)$/i, 'node'],
  [/\.(sh|bash|zsh|fish)$/i, 'shell'],
  [/\.(ps1|psm1)$/i, 'powershell'],
  [/\.(bat|cmd)$/i, 'cmd'],
  [/\.rb$/i, 'ruby'],
  [/\.go$/i, 'go'],
  [/\.rs$/i, 'rust'],
  [/\.(pl|pm)$/i, 'perl'],
  [/\.php$/i, 'php'],
  [/\.(exe|dll|so|dylib|bin)$/i, 'binary'],
];

const INSTALLERS: [RegExp, string][] = [
  [/\bpip3? install\b/, 'pip'],
  [/\buv (?:pip|add|tool) install\b|\buv add\b/, 'uv'],
  [/\buvx\s/, 'uvx'],
  [/\bnpm (?:i|install|add)\b/, 'npm'],
  [/\bnpx\s/, 'npx'],
  [/\b(?:pnpm|yarn) (?:add|install|dlx)\b/, 'pnpm/yarn'],
  [/\bbunx?\s/, 'bun'],
  [/\bbrew install\b/, 'brew'],
  [/\b(?:apt|apt-get|yum|dnf|apk) (?:-y )?install\b/, 'system packages'],
  [/\bcargo install\b/, 'cargo'],
  [/\bgo install\b/, 'go'],
  [/\bgem install\b/, 'gem'],
];

// variables a script reads that look like credentials
const ENV_READ = [
  /os\.environ(?:\.get)?\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
  /\$\{?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?))\}?/g,
];
const CREDENTIAL = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)$/;

const HOME_PATH = /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/(\.?[\w.-]+)/g;
const URL_HOST = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;
// documentation and placeholders, not places a skill connects to
const NOT_A_HOST = /(^|\.)(example\.(com|org|net)|localhost|schema\.org|w3\.org|json-schema\.org|creativecommons\.org|opensource\.org|spdx\.org)$/i;
// license texts name their own web sites
const LICENSE_FILE = /(^|\/)(LICEN[CS]E|COPYING|NOTICE)(\.\w+)?$/i;

const uniq = (xs: Iterable<string>, max = 30) => [...new Set(xs)].sort().slice(0, max);

/** A skill's profile, from its files and its frontmatter (allowed-tools is the only thing it declares). */
export function skillPermissions(files: PackageFile[], allowedTools: string[] | undefined): PermissionProfile {
  const runs = new Set<string>();
  const installs = new Set<string>();
  const network = new Set<string>();
  const secrets = new Set<string>();
  const paths = new Set<string>();
  for (const f of files) {
    for (const [re, name] of RUNTIME_OF) if (re.test(f.path)) runs.add(name);
    if (f.executable && !RUNTIME_OF.some(([re]) => re.test(f.path))) runs.add('executable');
    const text = asText(f.data);
    if (text === null) continue;
    for (const [re, name] of INSTALLERS) if (re.test(text)) installs.add(name);
    if (!LICENSE_FILE.test(f.path)) {
      for (const m of text.matchAll(URL_HOST)) {
        const host = m[1].toLowerCase();
        if (!NOT_A_HOST.test(host)) network.add(host);
      }
    }
    for (const re of ENV_READ) for (const m of text.matchAll(re)) if (CREDENTIAL.test(m[1])) secrets.add(m[1]);
    for (const m of text.matchAll(HOME_PATH)) paths.add(`~/${m[1]}`);
  }
  return {
    declared: allowedTools?.length ? { tools: allowedTools } : {},
    detected: {
      ...emptyPermissions(),
      runsCode: uniq(runs),
      installs: uniq(installs),
      network: uniq(network),
      secrets: uniq(secrets),
      paths: uniq(paths),
      tools: allowedTools ?? [],
    },
  };
}
