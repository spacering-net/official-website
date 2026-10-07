/**
 * Responses kept at each Cloudflare location with the Cache API. What the
 * cache hands back has its max-age raised to the zone's Browser Cache TTL
 * (four hours unless set otherwise), which would keep a page that changes
 * hourly in browsers that long. So the Cache-Control a response is stored
 * with travels in a header of its own and is put back when it is served.
 */
const STORED = 'X-Stored-Cache-Control';

/**
 * This Cloudflare location's cache. None in development (astro dev), where
 * pages change with every edit and a copy kept from before would hide it.
 */
export function edgeCache(): Cache | undefined {
  if (import.meta.env?.DEV) return undefined;
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/**
 * Where a response for `url` is kept: per deployment (`version`, from the
 * version metadata binding). A page names the scripts and styles of the build
 * that rendered it, and a new deployment serves only its own, so a page kept
 * from the last one would load without them.
 */
export function cacheKey(url: string, version: string | undefined): Request {
  const key = new URL(url);
  if (version) key.searchParams.set('__deployment', version);
  return new Request(key, { method: 'GET' });
}

/** The copy of `res` to put in the cache. */
export function forCache(res: Response): Response {
  const copy = new Response(res.clone().body, res);
  const policy = res.headers.get('Cache-Control');
  if (policy) copy.headers.set(STORED, policy);
  return copy;
}

/** A response from the cache, as it is to be served. */
export function fromCache(hit: Response): Response {
  const res = new Response(hit.body, hit);
  const policy = res.headers.get(STORED);
  if (policy) res.headers.set('Cache-Control', policy);
  res.headers.delete(STORED);
  return res;
}
