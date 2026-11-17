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

/** IPv4 ranges that are not the public internet (RFC 6890 and its successors), as [first octets, prefix length]. */
const NON_PUBLIC_V4: [number[], number][] = [
  [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12], [[192, 0, 0], 24], [[192, 0, 2], 24],
  [[192, 88, 99], 24], [[192, 168], 16], [[198, 18], 15], [[198, 51, 100], 24], [[203, 0, 113], 24], [[224], 4], [[240], 4],
];

function publicV4(octets: number[]): boolean {
  const n = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return !NON_PUBLIC_V4.some(([start, bits]) => {
    const base = ((start[0] << 24) | ((start[1] ?? 0) << 16) | ((start[2] ?? 0) << 8)) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** The eight 16-bit groups of an IPv6 address as the URL parser writes it (compressed hex, no dotted tail), or null. */
function v6Groups(h: string): number[] | null {
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

/**
 * Only global unicast (2000::/3), minus the ranges inside it that are not
 * an ordinary public host: Teredo and the other IETF special-purpose blocks
 * (2001::/23), documentation (2001:db8::/32, 3fff::/20) and 6to4 (2002::/16),
 * which wraps an IPv4 address of any kind. Loopback, link-local, unique-local,
 * multicast, IPv4-mapped and NAT64 addresses all fall outside 2000::/3.
 */
function publicV6(g: number[]): boolean {
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if (g[0] === 0x2002) return false;
  if (g[0] === 0x3fff && g[1] < 0x1000) return false;
  return true;
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
  // A trailing dot names the same host ("localhost." is localhost).
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h.includes(':')) {
    const groups = v6Groups(h);
    return !!groups && publicV6(groups);
  }
  // The URL parser has already turned every IPv4 spelling (hex, octal, short forms) into dotted decimal.
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) return publicV4(v4.slice(1, 5).map(Number));
  if (!h.includes('.') || ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'localdomain'].some((s) => h === s || h.endsWith(`.${s}`))) return false;
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
