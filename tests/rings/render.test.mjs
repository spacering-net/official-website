import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderCard } from '../../api/rings/render.ts';

const PUBLIC = new URL('../../public/', import.meta.url);
const sources = (over = {}) => ({
  asset: async (path) => new Uint8Array(readFileSync(new URL(`.${path}`, PUBLIC))),
  avatar: async () => new Uint8Array(readFileSync(new URL('apple-touch-icon.png', PUBLIC))),
  fallbacks: async () => [],
  ...over,
});
const card = (over = {}) => ({ number: 10000, name: 'Ada Ring', image: '/api/avatars/x/y.png', since: '2026-10-07T03:12:00.000Z', lang: 'en', ...over });
const isJpeg = (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;

test("a render whose files cannot be had fails, and the next one reads them again", async () => {
  await assert.rejects(renderCard(card(), sources({ asset: async () => { throw new Error('no files'); } })), /no files/);
  const { jpeg, complete } = await renderCard(card(), sources());
  assert.ok(isJpeg(jpeg));
  assert.equal(complete, true);
});

test('renders asked for at once take their turns, and all finish', async () => {
  const results = await Promise.all([card(), card({ lang: 'zh', name: null }), card({ number: 1234567, image: null })].map((c) => renderCard(c, sources())));
  for (const { jpeg } of results) assert.ok(isJpeg(jpeg));
  // a picture that is gone is left out, and the render says so
  const missing = await renderCard(card(), sources({ avatar: async () => null }));
  assert.equal(missing.complete, false);
  assert.ok(isJpeg(missing.jpeg));
});
