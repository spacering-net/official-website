const ENTRIES = new Set([
  '/authorize', '/authorize/', '/authorize/index.html', '/authorize.html',
  '/zh/authorize', '/zh/authorize/', '/zh/authorize/index.html', '/zh/authorize.html',
]);

/**
 * Identify the authorization namespace before any general page rendering.
 * Decode and collapse path aliases only for classification; an alias never
 * becomes an accepted entry. Authorization HTML is not a static asset, so
 * requests bypassing Worker-first routing cannot receive it from ASSETS.
 */
export function authorizationPage(pathname: string): { zh: boolean; accepted: boolean } | null {
  let decoded = pathname;
  while (decoded.includes('%')) {
    let next: string;
    try { next = decodeURIComponent(decoded); }
    catch {
      // Still recognize encoded ASCII in an otherwise malformed path. This
      // cannot authorize it; only the unchanged canonical entry is accepted.
      next = decoded.replace(/%([0-7][0-9a-f])/gi, (_match, byte: string) => String.fromCharCode(parseInt(byte, 16)));
    }
    if (next === decoded) break;
    decoded = next;
  }
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  const match = /^\/(?:(zh)\/)?authorize(?:\.html)?(?:\/|$)/i.exec(`/${segments.join('/')}`);
  return match ? { zh: !!match[1], accepted: ENTRIES.has(pathname) } : null;
}
