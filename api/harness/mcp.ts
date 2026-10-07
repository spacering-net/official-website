import type { PinnedPackage } from './model';
import { emptyPermissions, type PermissionProfile } from './scan/permissions';

/** The parts of an MCP Registry server.json that Harness reads; the rest is kept as it is. */
export interface ServerJson {
  name: string;
  description?: string;
  title?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  packages?: ServerPackage[];
  remotes?: { type?: string; url?: string; headers?: Input[] }[];
}

interface Input {
  name?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
}

export interface ServerPackage {
  registryType?: string;
  registryBaseUrl?: string;
  identifier?: string;
  version?: string;
  fileSha256?: string;
  transport?: { type?: string; url?: string; headers?: Input[] };
  environmentVariables?: Input[];
}

/** Package registries and what runs them. */
const RUNTIME: Record<string, string> = { npm: 'node', pypi: 'python', oci: 'docker', nuget: 'dotnet', mcpb: 'bundle', cargo: 'rust' };

/** How the server runs: its first package's runtime, or 'remote' for a hosted endpoint. */
export function serverRuntime(s: ServerJson): string {
  const p = s.packages?.[0];
  if (p?.registryType) return RUNTIME[p.registryType] ?? p.registryType;
  return s.remotes?.length ? 'remote' : 'none';
}

/** What the server installs, as one key: its first package, or its first endpoint. Copies under other names share it. */
export function serverDedupeKey(s: ServerJson): string | null {
  const p = s.packages?.[0];
  if (p?.registryType && p.identifier) return `${p.registryType}:${p.identifier.toLowerCase()}`;
  const url = s.remotes?.[0]?.url;
  if (!url) return null;
  try {
    const u = new URL(url);
    return `remote:${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Whether the server's GitHub repository belongs to the namespace's own account (io.github.<login>). */
export function ownsRepository(s: ServerJson, login: string | undefined): boolean {
  if (!login) return false;
  const m = /^https:\/\/github\.com\/([^/]+)\//i.exec(s.repository?.url ?? '');
  return !!m && m[1].toLowerCase() === login.toLowerCase();
}

/** Hosts a remote endpoint may not be: this machine, private networks, names that only resolve inside one. */
export function isPublicHttps(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.') && !h.includes(':')) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
  }
  if (h.includes(':') && (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::')) return false;
  return true;
}

/**
 * Why a registry server should stay listed rather than go on the shelves
 * (docs: section 3): no repository, no real description, an endpoint that
 * is not a public https address, packages Harness cannot check yet, or a
 * deprecated status at the registry.
 */
export function serverReasons(s: ServerJson, status: string | undefined): string[] {
  const reasons: string[] = [];
  if (!s.repository?.url || !/^https:\/\//.test(s.repository.url)) reasons.push('no_repository');
  const description = (s.description ?? '').trim();
  if (description.length < 20 || description.toLowerCase() === s.name.toLowerCase()) reasons.push('no_description');
  for (const r of s.remotes ?? []) if (!r.url || !isPublicHttps(r.url)) reasons.push('remote_not_public');
  for (const p of s.packages ?? []) {
    if (p.registryType !== 'npm' && p.registryType !== 'pypi' && !(p.registryType === 'mcpb' && p.fileSha256)) reasons.push('package_unverifiable');
  }
  if (!s.packages?.length && !s.remotes?.length) reasons.push('nothing_to_install');
  if (status === 'deprecated') reasons.push('deprecated');
  return [...new Set(reasons)];
}

/** The packages to pin, before the registries are asked: npm and PyPI are looked up by a job, MCP bundles carry their own hash. */
export function packagesToPin(s: ServerJson): PinnedPackage[] {
  return (s.packages ?? [])
    .filter((p) => p.registryType && p.identifier)
    .map((p) => ({
      registryType: p.registryType as string,
      identifier: p.identifier as string,
      version: p.version && p.version !== 'latest' ? p.version : null,
      verified: p.registryType === 'npm' || p.registryType === 'pypi' ? 'pending' : 'unchecked',
      ...(p.fileSha256 ? { fileSha256: p.fileSha256 } : {}),
    }));
}

/** What a server.json declares it needs, and what follows from its packages and endpoints. */
export function serverPermissions(s: ServerJson, pinned: PinnedPackage[]): PermissionProfile {
  const secrets = new Set<string>();
  const runs = new Set<string>();
  const network = new Set<string>();
  for (const p of s.packages ?? []) {
    if (p.registryType) runs.add(RUNTIME[p.registryType] ?? p.registryType);
    for (const v of p.environmentVariables ?? []) if (v.isSecret && v.name) secrets.add(v.name);
    for (const h of p.transport?.headers ?? []) if (h.isSecret && h.name) secrets.add(h.name);
  }
  for (const r of s.remotes ?? []) {
    try {
      if (r.url) network.add(new URL(r.url).hostname);
    } catch {
      // an invalid endpoint is a listed reason already
    }
    for (const h of r.headers ?? []) if (h.isSecret && h.name) secrets.add(h.name);
  }
  const installs = pinned.map((p) => `${p.registryType}:${p.identifier}${p.version ? `@${p.version}` : ''}`);
  const installScripts = pinned.filter((p) => p.hasInstallScript).map((p) => `${p.registryType}:${p.identifier}`);
  const detected = { ...emptyPermissions(), runsCode: [...runs].sort(), installs, installScripts, network: [...network].sort(), secrets: [...secrets].sort() };
  return { declared: { secrets: detected.secrets, network: detected.network }, detected };
}
