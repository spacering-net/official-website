/**
 * Responses kept at each Cloudflare location with the Cache API. What the
 * cache hands back has its max-age raised to the zone's Browser Cache TTL
 * (four hours unless set otherwise), which would keep a page that changes
 * hourly in browsers that long. So the Cache-Control a response is stored
 * with travels in a header of its own and is put back when it is served.
 */
const STORED = 'X-Stored-Cache-Control';

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
