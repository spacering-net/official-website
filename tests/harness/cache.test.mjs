import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forCache, fromCache } from '../../api/harness/cache.ts';

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
