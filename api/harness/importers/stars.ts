import { popularityOf } from '../store';

/**
 * GitHub stars of the repositories behind imported items: the first signal
 * of popularity, before Harness has installs of its own (H3). Asked of
 * GitHub's GraphQL API, a hundred repositories a query; needs GITHUB_TOKEN.
 * A repository that is gone is recorded as -1, so it is not asked again.
 */
export async function refreshStars(env: Env, limit = 1000): Promise<number> {
  if (!env.GITHUB_TOKEN) return 0;
  const db = env.HARNESS_DB;
  const { results } = await db
    .prepare(
      `SELECT id, repository_url, quality, featured FROM items
        WHERE repo_stars IS NULL AND repository_url LIKE 'https://github.com/%' AND status IN ('public', 'listed', 'pending')
        LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string; repository_url: string; quality: number; featured: number }>();

  const byRepo = new Map<string, typeof results>();
  for (const r of results) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?(?:[/?#]|$)/.exec(r.repository_url);
    const key = m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
    if (key) byRepo.set(key, [...(byRepo.get(key) ?? []), r]);
  }
  const repos = [...byRepo.keys()];
  let updated = 0;
  for (let i = 0; i < repos.length; i += 100) {
    const chunk = repos.slice(i, i + 100);
    // owner and name are checked against GitHub's own character sets above, so they are safe to quote
    const query = `query { ${chunk
      .map((full, j) => {
        const [owner, name] = full.split('/');
        return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { stargazerCount }`;
      })
      .join(' ')} }`;
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'spacering.net-harness' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL answered ${res.status}`);
    // a missing repository comes back as null with an error beside it: that is an answer too.
    // No data at all (rate limited, say) is not: try again later.
    const { data } = (await res.json()) as { data?: Record<string, { stargazerCount: number } | null> | null };
    if (!data) throw new Error('GitHub GraphQL returned no data');
    const statements: D1PreparedStatement[] = [];
    chunk.forEach((full, j) => {
      const stars = data?.[`r${j}`]?.stargazerCount ?? -1;
      for (const item of byRepo.get(full) ?? []) {
        statements.push(
          db.prepare('UPDATE items SET repo_stars = ?1, popularity = ?2 WHERE id = ?3').bind(stars, popularityOf(item.quality, stars, !!item.featured), item.id),
        );
      }
    });
    for (let k = 0; k < statements.length; k += 90) await db.batch(statements.slice(k, k + 90));
    updated += statements.length;
  }
  return updated;
}
