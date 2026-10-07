import type { PinnedPackage } from '../model';

/**
 * Look up the packages an MCP server launches on npm and PyPI: does the exact
 * version exist, what hash does the registry give it, and does it run code
 * as it installs. Answers are kept in package_versions, shared by every
 * server naming the same version, and asked again after a week.
 */

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const HEADERS = { 'User-Agent': 'spacering.net-harness', Accept: 'application/json' };

interface Found {
  found: boolean;
  version: string | null;
  data?: Pick<PinnedPackage, 'integrity' | 'files' | 'hasInstallScript'>;
}

async function getJson(url: string): Promise<unknown | null> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function lookupNpm(name: string, version: string | null): Promise<Found> {
  // scoped names keep their @ and encode the slash
  const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const doc = (await getJson(`https://registry.npmjs.org/${path}/${version ? encodeURIComponent(version) : 'latest'}`)) as {
    version?: string;
    dist?: { integrity?: string };
    scripts?: Record<string, string>;
    gypfile?: boolean;
  } | null;
  if (!doc?.version) return { found: false, version };
  const s = doc.scripts ?? {};
  return {
    found: true,
    version: doc.version,
    data: { integrity: doc.dist?.integrity, hasInstallScript: !!(s.preinstall || s.install || s.postinstall || doc.gypfile) },
  };
}

async function lookupPypi(name: string, version: string | null): Promise<Found> {
  const base = `https://pypi.org/pypi/${encodeURIComponent(name)}`;
  const doc = (await getJson(version ? `${base}/${encodeURIComponent(version)}/json` : `${base}/json`)) as {
    info?: { version?: string };
    urls?: { filename: string; packagetype: string; digests?: { sha256?: string } }[];
  } | null;
  if (!doc?.info?.version) return { found: false, version };
  const files = (doc.urls ?? [])
    .filter((u) => u.digests?.sha256)
    .slice(0, 30)
    .map((u) => ({ name: u.filename, sha256: u.digests!.sha256!, kind: u.packagetype === 'bdist_wheel' ? ('wheel' as const) : ('sdist' as const) }));
  // no wheel at all: installing means building from source, which runs its build scripts
  return { found: files.length > 0, version: doc.info.version, data: { files, hasInstallScript: !files.some((f) => f.kind === 'wheel') } };
}

/**
 * Pin npm and PyPI packages: exact version, hashes, install scripts. Others
 * pass through unchanged. A lookup that fails leaves the package 'pending'.
 */
export async function pinPackages(db: D1Database, packages: PinnedPackage[]): Promise<PinnedPackage[]> {
  const out: PinnedPackage[] = [];
  for (const p of packages) {
    if (p.registryType !== 'npm' && p.registryType !== 'pypi') {
      out.push(p);
      continue;
    }
    const key = p.version ?? 'latest';
    const cached = await db
      .prepare('SELECT found, data, checked_at FROM package_versions WHERE registry_type = ?1 AND identifier = ?2 AND version = ?3')
      .bind(p.registryType, p.identifier, key)
      .first<{ found: number; data: string | null; checked_at: string }>();
    let found: Found;
    if (cached && Date.now() - Date.parse(cached.checked_at) < STALE_MS) {
      const data = cached.data ? (JSON.parse(cached.data) as Found['data'] & { version?: string }) : undefined;
      found = { found: !!cached.found, version: data?.version ?? p.version, data };
    } else {
      try {
        found = p.registryType === 'npm' ? await lookupNpm(p.identifier, p.version) : await lookupPypi(p.identifier, p.version);
      } catch (err) {
        // the registry is down or slow: not an answer. Stays pending, and is asked again later.
        console.warn(`[harness] ${p.registryType} ${p.identifier}: lookup failed`, String(err));
        out.push({ ...p, verified: 'pending' });
        continue;
      }
      await db
        .prepare(
          `INSERT INTO package_versions (registry_type, identifier, version, found, data, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (registry_type, identifier, version) DO UPDATE SET found = excluded.found, data = excluded.data, checked_at = excluded.checked_at`,
        )
        .bind(p.registryType, p.identifier, key, found.found ? 1 : 0, JSON.stringify({ ...found.data, version: found.version }), new Date().toISOString())
        .run();
    }
    out.push({ ...p, version: found.version, verified: found.found ? 'ok' : 'missing', ...found.data });
  }
  return out;
}
