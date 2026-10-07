import { CODEG_FALLBACK, SITE } from '../config';

export interface RepoStats {
  stars: number;
  forks: number;
  version: string;
  license: string;
}

let cached: Promise<RepoStats> | undefined;

async function load(repo: string): Promise<RepoStats> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'spacering.net-build',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const signal = AbortSignal.timeout(6000);
    const [repoRes, relRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}`, { headers, signal }),
      fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal }),
    ]);
    if (!repoRes.ok) throw new Error(`repo ${repoRes.status}`);
    const r = (await repoRes.json()) as {
      stargazers_count: number;
      forks_count: number;
      license?: { spdx_id?: string } | null;
    };
    const rel = relRes.ok ? ((await relRes.json()) as { tag_name?: string }) : {};
    return {
      stars: r.stargazers_count ?? CODEG_FALLBACK.stars,
      forks: r.forks_count ?? CODEG_FALLBACK.forks,
      version: rel.tag_name ?? CODEG_FALLBACK.version,
      license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : CODEG_FALLBACK.license,
    };
  } catch (err) {
    console.warn(`[github] using fallback stats for ${repo}:`, (err as Error).message);
    return { ...CODEG_FALLBACK };
  }
}

/** Fetched once per build and shared by every locale. */
export function getCodegStats(): Promise<RepoStats> {
  cached ??= load(SITE.codeg.repo);
  return cached;
}

export function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(n);
}
