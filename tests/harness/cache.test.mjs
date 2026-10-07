import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheKey, forCache, fromCache } from '../../api/harness/cache.ts';

test('a cached response is served with the Cache-Control it was stored with', async () => {
  const res = new Response('page', { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300', ETag: '"a"' } });
  const stored = forCache(res);
  // what the Cache API hands back: max-age raised to the zone's Browser Cache TTL
  stored.headers.set('Cache-Control', 'public, max-age=14400, s-maxage=300');
  const served = fromCache(stored);
  assert.equal(served.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=300');
  assert.equal(served.headers.get('ETag'), '"a"');
  assert.ok(!served.headers.has('X-Stored-Cache-Control'));
  assert.equal(await served.text(), 'page');
  assert.equal(await res.text(), 'page');
});

test('cached responses are kept per deployment, under their own query', () => {
  const url = 'https://spacering.net/zh/harness/?q=pdf&kind=skill';
  const a = cacheKey(url, 'v1').url;
  const b = cacheKey(url, 'v2').url;
  assert.notEqual(a, b);
  assert.equal(new URL(a).searchParams.get('q'), 'pdf');
  assert.equal(new URL(a).searchParams.get('kind'), 'skill');
  assert.equal(cacheKey(url, undefined).url, url);
  assert.equal(cacheKey(url, 'v1').method, 'GET');
});
