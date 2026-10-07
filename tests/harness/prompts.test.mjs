import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem, listItems, listTags, promptText } from '../../api/harness/catalog.ts';
import { fetchMedia, imageInfo } from '../../api/harness/importers/media.ts';
import { importPrompts, readEntries } from '../../api/harness/importers/prompts.ts';
import { parsePrompt, postTime, promptFile, promptKey, promptLang, promptTitle } from '../../api/harness/prompt.ts';
import { rescan } from '../../api/harness/rescan.ts';
import { recountFacets } from '../../api/harness/search.ts';
import { testEnv } from './env.mjs';

test('PROMPT.md: frontmatter like a command, the prompt as its body, and back', () => {
  const text = 'Build a "loop": the camera flies through.\n\n- 20 s, 30 fps';
  const file = promptFile({ name: 'loop-zoom', model: 'claude-opus-5-5', sharedBy: '@koldo2k', source: 'https://x.com/koldo2k/status/2103129343253778767', partial: true }, text);
  assert.ok(file.startsWith('---\nname: loop-zoom\n'));
  assert.ok(file.endsWith(`---\n${text}\n`));
  const back = parsePrompt(file);
  assert.deepEqual(back.errors, []);
  assert.equal(back.text, text);
  assert.deepEqual(back.fields, {
    name: 'loop-zoom',
    description: null,
    model: 'claude-opus-5-5',
    argumentHint: null,
    sharedBy: '@koldo2k',
    source: 'https://x.com/koldo2k/status/2103129343253778767',
    partial: true,
  });
  assert.deepEqual(parsePrompt('no frontmatter').errors, ['frontmatter_missing']);
  assert.deepEqual(parsePrompt('---\nname: Bad Name\n---\nText').errors, ['name_invalid']);
});

test('a title is the first sentence, plain and short; copies of a prompt compare equal', () => {
  assert.equal(promptTitle('make a 3D solar system in Three.js. Then add moons.'), 'Make a 3D solar system in Three.js.');
  assert.equal(promptTitle('<inputs> Ask me for: 8 to 12 UI states\nmore'), 'Ask me for: 8 to 12 UI states');
  assert.equal(promptTitle('# **Bold** heading line\nbody'), 'Bold heading line');
  assert.equal(promptTitle('make a dynamic 15-second motion graphics video that shows what an incredible motion designer you are'), 'Make a dynamic 15-second motion graphics video that shows what an…');
  assert.ok([...promptTitle('请用Manim给我制作一个导数概念学习的视频，要求通俗易懂，并且有例子，引人思考。配音使用edge-tts')].length <= 36);
  assert.equal(promptKey('Go all out.'), promptKey('  go  all out '));
  assert.equal(promptKey("like it’s yours. go all out'"), promptKey("like it's yours. go all out."));
  assert.notEqual(promptKey('a résumé'), promptKey('a resume'));
  assert.equal(promptLang('make a video'), 'en');
  assert.equal(promptLang('设计个动画，介绍本项目的各项特性'), 'zh');
  assert.equal(promptLang('한국의 추석에 어울리는 요소를 서치해서'), 'ko');
  assert.equal(promptLang('アニメーションを作って'), 'ja');
  assert.equal(postTime('https://x.com/ajith_io/status/2103449416325890146'), '2026-09-25T11:39:55.709Z');
  assert.equal(postTime('https://example.com/ajith_io/status/2103449416325890146'), null);
});

/** The first bytes of an image of each kind, as much as its size is read from. */
const webp = (chunk, body) => {
  const b = new Uint8Array(30 + 8);
  b.set(new TextEncoder().encode(`RIFF....WEBP${chunk}`), 0);
  b.set(body, 20);
  return b.buffer;
};

test('a picture is told by its bytes, with its size: WebP of each kind, PNG, GIF, JPEG; nothing else', () => {
  assert.deepEqual(imageInfo(webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0xc0, 0x03, 0x1c, 0x02])), { type: 'image/webp', width: 960, height: 540 });
  const bits = 399 | (225 << 14);
  assert.deepEqual(imageInfo(webp('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255])), { type: 'image/webp', width: 400, height: 226 });
  assert.deepEqual(imageInfo(webp('VP8X', [0x12, 0, 0, 0, 399 & 255, 399 >> 8, 0, 225, 0, 0])), { type: 'image/webp', width: 400, height: 226 });
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 300);
  new DataView(png.buffer).setUint32(20, 200);
  assert.deepEqual(imageInfo(png.buffer), { type: 'image/png', width: 300, height: 200 });
  assert.deepEqual(imageInfo(new Uint8Array([...new TextEncoder().encode('GIF89a'), 64, 1, 32, 0]).buffer), { type: 'image/gif', width: 320, height: 32 });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 8, 0x01, 0x2c, 0x01, 0x90, 3, 0, 0, 0]);
  assert.deepEqual(imageInfo(jpeg.buffer), { type: 'image/jpeg', width: 400, height: 300 });
  assert.equal(imageInfo(new TextEncoder().encode('<!doctype html><html><head><title>Not found').buffer), null);
});

// ---------------------------------------------------------------------------
// a collection on GitHub, as the API, the commit and the data file answer

const CONFIG = {
  kind: 'prompt',
  reader: 'json',
  file: 'data/list.json',
  fields: { id: 'slug', text: 'prompt', partial: 'partial', by: 'author', byUrl: 'author_url', link: 'post_url', cover: 'poster', category: 'category', labels: 'tech', added: 'added' },
  motion: 'https://media.example/{id}/preview.webp',
  model: 'claude-opus-5-5',
  rights: 'creators',
  media: ['media.example'],
  categories: { motion: { en: 'Motion graphics', zh: '动态图形' } },
  tags: { motion: ['animation', 'video'], explainer: ['animation', 'education'], canvas: ['creative-coding'] },
};

const VIRAL = "make a dynamic 15-second motion graphics video that shows what an incredible motion designer you are, like it's your showreel. go all out.";
const entry = (slug, prompt, over = {}) => ({
  slug,
  prompt,
  partial: false,
  author: slug.split('-')[0],
  author_url: `https://x.com/${slug.split('-')[0]}`,
  post_url: `https://x.com/${slug.split('-')[0]}/status/${over.status ?? '2103449416325890146'}`,
  poster: `https://media.example/${slug}/original.webp`,
  category: 'motion',
  tech: ['canvas'],
  added: '2026-09-26',
  ...over,
});

function collection(t, entries, sha = 'c0ffee1') {
  return t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/someone/prompts') {
      return Response.json({ full_name: 'someone/prompts', html_url: 'https://github.com/someone/prompts', default_branch: 'main', stargazers_count: 2400, archived: false, license: { spdx_id: 'MIT' }, owner: { id: 7, login: 'someone', type: 'User' } });
    }
    if (u === 'https://api.github.com/repos/someone/prompts/commits/main') return Response.json({ sha, commit: { committer: { date: '2026-09-29T00:00:00Z' } } });
    if (u === `https://raw.githubusercontent.com/someone/prompts/${sha}/data/list.json`) return Response.json(entries);
    throw new Error(`unexpected fetch ${u}`);
  });
}

const first = [
  // the same prompt twice (the copy's quote and full stop differ): one item, two results, the earlier post first
  entry('alice-001', VIRAL, { status: '2103129343253778767' }),
  entry('bob-002', VIRAL.replace("it's", 'it’s').replace(/\.$/, '')),
  entry('carol-003', 'Opus 5.5 made this explainer about orbits', { partial: true, category: 'explainer', tech: [] }),
  entry('dave-004', 'Go all out.'),
  // an email address is not a handle; a picture from a host the config does not allow is not taken
  entry('eve-005', 'Build a MapleStory clone in Raylib-cs, with two levels.', { author: 'eve@example.com', poster: 'https://elsewhere.example/eve.webp' }),
  entry('alice-001', 'a second entry with an id already seen'),
  { slug: 'nobody-006', author: 'nobody' },
];

const item = (env, name) => env.HARNESS_DB.rows('SELECT * FROM items WHERE name = ?', name)[0];

test('a collection becomes one item per prompt, credited, its results and pictures recorded', async (t) => {
  const env = testEnv();
  const mock = collection(t, first);
  const read = await readEntries(first, CONFIG);
  assert.deepEqual(read.rejected, [{ path: 'data/list.json#6', errors: ['text_missing'] }]);
  assert.equal(read.entries.length, 5);
  assert.equal(read.entries.find((e) => e.id === 'eve-005').by, null);
  assert.equal(read.entries.find((e) => e.id === 'eve-005').cover, null);

  const result = await importPrompts(env, 'someone/prompts', CONFIG, null);
  assert.deepEqual([result.skills, result.created, result.remaining, result.retired], [4, 4, 0, 0]);

  const viral = item(env, 'alice-001');
  assert.equal(viral.kind, 'prompt');
  assert.equal(viral.status, 'public');
  assert.equal(viral.source_key, 'github:someone/prompts:data/list.json#alice-001');
  assert.equal(viral.license, null);
  assert.equal(viral.runtime, 'none');
  assert.equal(viral.title_en, 'Make a dynamic 15-second motion graphics video that shows what an…');
  const card = JSON.parse(viral.card);
  assert.deepEqual([card.results, card.by, card.model, card.partial], [2, 'alice', 'claude-opus-5-5', false]);
  assert.deepEqual(card.faces.map((f) => f.cover), ['https://media.example/alice-001/original.webp', 'https://media.example/bob-002/original.webp']);
  assert.ok(viral.boost > 0 && viral.popularity > Math.log10(2401));
  assert.deepEqual(
    env.HARNESS_DB.rows('SELECT tag_id FROM item_tags WHERE item_id = ? ORDER BY tag_id', viral.id).map((r) => r.tag_id),
    ['animation', 'creative-coding', 'video'],
  );
  // a part of a prompt, and a fragment, are kept but not on the shelves
  assert.deepEqual([item(env, 'carol-003').status, JSON.parse(item(env, 'carol-003').listed_reasons)], ['listed', ['prompt_partial']]);
  assert.deepEqual([item(env, 'dave-004').status, JSON.parse(item(env, 'dave-004').listed_reasons)], ['listed', ['prompt_short']]);
  assert.equal(JSON.parse(item(env, 'eve-005').card).by, null);

  // the package is PROMPT.md, kept (and zipped) here
  const version = env.HARNESS_DB.rows('SELECT * FROM item_versions WHERE id = ?', viral.latest_version_id)[0];
  const meta = JSON.parse(version.metadata);
  assert.equal(meta.prompt.text, VIRAL);
  assert.equal(meta.prompt.rights, 'creators');
  assert.deepEqual(meta.showcases.map((s) => s.by.name), ['alice', 'bob']);
  assert.deepEqual(meta.showcases[0].categoryName, { en: 'Motion graphics', zh: '动态图形' });
  const file = env.HARNESS_DB.rows('SELECT path, sha256 FROM version_files WHERE version_id = ?', version.id);
  assert.deepEqual(file.map((f) => f.path), ['PROMPT.md']);
  const parsed = parsePrompt(new TextDecoder().decode(env.HARNESS_FILES.objects.get(`blobs/${file[0].sha256}`)));
  assert.deepEqual([parsed.fields.name, parsed.fields.sharedBy, parsed.text], ['alice-001', '@alice', VIRAL]);
  assert.ok(version.archive_sha256);

  // every picture named on an allowed host, once, waiting for the media job: four covers, five moving previews
  const pictures = env.HARNESS_DB.rows("SELECT url FROM media WHERE status = 'pending' ORDER BY url").map((r) => r.url);
  assert.equal(pictures.length, 4 + 5);
  assert.ok(!pictures.some((u) => u.includes('elsewhere.example')));

  // nothing new at the same commit; everything again when forced, and nothing changes
  assert.equal((await importPrompts(env, 'someone/prompts', CONFIG, result.commit)).changed, false);
  const again = await importPrompts(env, 'someone/prompts', CONFIG, result.commit, true);
  assert.deepEqual([again.created, again.updated, again.retired], [0, 0, 0]);
  mock.mock.restore();
});

test('the media job keeps pictures by their bytes; the cards and the page show the kept ones only', async (t) => {
  const env = testEnv();
  collection(t, first);
  await importPrompts(env, 'someone/prompts', CONFIG, null);
  const still = webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0xc0, 0x03, 0x1c, 0x02]);
  const moving = webp('VP8X', [0x12, 0, 0, 0, 399 & 255, 399 >> 8, 0, 225, 0, 0]);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u === 'https://media.example/alice-001/original.webp') return new Response(still, { headers: { 'content-type': 'image/webp' } });
    if (u === 'https://media.example/alice-001/preview.webp') return new Response(moving, { headers: { 'content-type': 'image/webp' } });
    // a missing picture answered with a page, as some hosts do
    if (u === 'https://media.example/bob-002/original.webp') return new Response('<!doctype html><title>Not found</title>', { headers: { 'content-type': 'text/html' } });
    if (u === 'https://media.example/eve-005/preview.webp') return new Response('busy', { status: 503 });
    return new Response('not here', { status: 404 });
  });
  assert.equal(await fetchMedia(env), 9);
  const rows = Object.fromEntries(env.HARNESS_DB.rows('SELECT url, status, type, width, height FROM media').map((r) => [r.url.replace('https://media.example/', ''), r]));
  assert.deepEqual([rows['alice-001/original.webp'].status, rows['alice-001/original.webp'].width, rows['alice-001/original.webp'].height], ['ok', 960, 540]);
  assert.deepEqual([rows['alice-001/preview.webp'].status, rows['alice-001/preview.webp'].width], ['ok', 400]);
  assert.equal(rows['bob-002/original.webp'].status, 'missing');
  assert.equal(rows['eve-005/preview.webp'].status, 'failed');
  // looked at already: nothing is due until days have passed
  assert.equal(await fetchMedia(env), 0);

  const db = env.HARNESS_DB;
  await recountFacets(db);
  const list = await listItems(db, { kind: 'prompt' });
  assert.equal(list.approxTotal, 2);
  const viral = list.items.find((i) => i.name === 'alice-001');
  assert.match(viral.prompt.cover, /^\/api\/harness\/v1\/media\/[0-9a-f]{64}\.webp$/);
  assert.match(viral.prompt.motion, /^\/api\/harness\/v1\/media\/[0-9a-f]{64}\.webp$/);
  assert.deepEqual([viral.prompt.results, viral.prompt.by, viral.prompt.partial], [2, 'alice', false]);
  assert.ok(viral.prompt.excerpt.startsWith('make a dynamic'));
  const eve = list.items.find((i) => i.name === 'eve-005');
  assert.deepEqual([eve.prompt.cover, eve.prompt.motion], [null, null]);
  assert.ok(env.HARNESS_FILES.objects.has(`media/${viral.prompt.cover.slice(-69, -5)}`));

  const detail = await getItem(db, 'someone', 'alice-001');
  assert.equal(detail.install.prompt.text, VIRAL);
  assert.deepEqual(
    detail.install.prompt.showcases.map((s) => [s.by.name, !!s.cover, !!s.motion]),
    [
      ['alice', true, true],
      ['bob', false, false],
    ],
  );
  assert.equal(await promptText(db, 'someone', 'alice-001'), VIRAL);
  assert.equal(await promptText(db, 'someone', 'carol-003'), 'Opus 5.5 made this explainer about orbits');
  assert.equal(await promptText(db, 'someone', 'nobody'), null);

  // within a kind, its own runtimes and tags are counted
  const facets = Object.fromEntries(db.rows('SELECT key, count FROM facets').map((r) => [r.key, r.count]));
  assert.equal(facets['kind:prompt'], 2);
  assert.equal(facets['runtime:none@prompt'], 2);
  assert.equal(facets['tag:animation@prompt'], 2);
  assert.equal(facets['tag:creative-coding@prompt'], 2);
  assert.equal((await listTags(db, 'prompt')).find((t) => t.id === 'animation').count, 2);
  assert.equal((await listTags(db, 'skill')).find((t) => t.id === 'animation').count, 0);
  assert.equal((await listItems(db, { kind: 'prompt', tag: 'animation' })).approxTotal, 2);
});

test('an edited prompt keeps its item; one edited to match another joins it; gone ones are retired', async (t) => {
  const env = testEnv();
  const mock = collection(t, first);
  await importPrompts(env, 'someone/prompts', CONFIG, null);
  mock.mock.restore();
  const before = item(env, 'eve-005');

  const second = [
    first[0],
    first[1],
    // carol's post now shares the whole prompt: hers joins the first item
    entry('carol-003', VIRAL, { status: '2103495232637882858' }),
    entry('eve-005', 'Build a MapleStory clone in Raylib-cs, with three levels.'),
  ];
  collection(t, second, 'c0ffee2');
  const result = await importPrompts(env, 'someone/prompts', CONFIG, 'c0ffee1');
  assert.deepEqual([result.skills, result.created, result.updated, result.retired], [2, 0, 2, 2]);

  const viral = item(env, 'alice-001');
  // not a copy of the item it absorbed (that one, of the same collection, holds no place against it)
  assert.equal(viral.status, 'public');
  assert.equal(JSON.parse(viral.card).results, 3);
  assert.equal(item(env, 'carol-003').status, 'retired');
  assert.equal(item(env, 'dave-004').status, 'retired');
  const eve = item(env, 'eve-005');
  assert.deepEqual([eve.id, eve.latest_revision, eve.status], [before.id, 2, 'public']);
  assert.ok(env.HARNESS_DB.rows("SELECT rowid FROM item_search WHERE rowid IN (SELECT seq FROM items WHERE name IN ('carol-003', 'dave-004'))").length === 0);
});

test('a rescan reads a prompt from its version, not from the repository', async (t) => {
  const env = testEnv();
  collection(t, first);
  await importPrompts(env, 'someone/prompts', CONFIG, null);
  t.mock.method(globalThis, 'fetch', async (url) => {
    throw new Error(`no fetch expected: ${url}`);
  });
  env.HARNESS_DB.sqlite.exec("UPDATE item_versions SET checks = json_set(checks, '$.rules', 'older')");
  const { count } = await rescan(env, 50, 0);
  assert.equal(count, 4);
  assert.equal(env.HARNESS_DB.rows("SELECT COUNT(*) AS n FROM item_versions WHERE json_extract(checks, '$.rules') = 'older'")[0].n, 0);
});

test('a part of a prompt and the whole of it are both kept, neither as a copy of the other', async (t) => {
  const env = testEnv();
  collection(t, [entry('pat-001', VIRAL, { partial: true, status: '2103129343253778767' }), entry('quinn-002', VIRAL)]);
  await importPrompts(env, 'someone/prompts', CONFIG, null);
  assert.deepEqual([item(env, 'pat-001').status, JSON.parse(item(env, 'pat-001').listed_reasons)], ['listed', ['prompt_partial']]);
  assert.deepEqual([item(env, 'quinn-002').status, JSON.parse(item(env, 'quinn-002').listed_reasons)], ['public', []]);
});

test('an entry that keeps a prompt another left, or takes over a gone one, is not a copy', async (t) => {
  const env = testEnv();
  const mock = collection(t, [entry('ann-001', VIRAL, { status: '2103129343253778767' }), entry('ben-002', VIRAL), entry('cy-003', 'Make a pixel-art fishing game with three lakes.')]);
  await importPrompts(env, 'someone/prompts', CONFIG, null);
  mock.mock.restore();
  assert.equal(JSON.parse(item(env, 'ann-001').card).results, 2);

  // ann's prompt changes, so ben's is now a prompt of its own; cy's entry is replaced by dee's, with the same prompt
  collection(t, [entry('ann-001', 'Make a 3D orbit of the planets, one minute long.', { status: '2103129343253778767' }), entry('ben-002', VIRAL), entry('dee-004', 'Make a pixel-art fishing game with three lakes.')], 'c0ffee2');
  await importPrompts(env, 'someone/prompts', CONFIG, 'c0ffee1');
  const status = (name) => [item(env, name).status, JSON.parse(item(env, name).listed_reasons)];
  assert.deepEqual(status('ann-001'), ['public', []]);
  assert.deepEqual(status('ben-002'), ['public', []]);
  assert.deepEqual(status('dee-004'), ['public', []]);
  assert.equal(item(env, 'cy-003').status, 'retired');
  assert.equal(JSON.parse(item(env, 'ben-002').card).results, 1);
  const shelf = env.HARNESS_DB.rows("SELECT dedupe_key, COUNT(*) AS n FROM items WHERE status = 'public' GROUP BY dedupe_key HAVING n > 1");
  assert.deepEqual(shelf, []);
});

test('a collection saved over several runs ends where one run would, with no copies on the way out', async (t) => {
  const env = testEnv();
  const many = Array.from({ length: 45 }, (_, i) => entry(`p${String(i).padStart(2, '0')}-x`, `Make animation number ${i}, with ${i} moving circles.`));
  const mock = collection(t, many);
  await importPrompts(env, 'someone/prompts', CONFIG, null);
  mock.mock.restore();

  // the next commit: the first entry's prompt goes to a new entry, posted before all of them (so saved in the first
  // run), while the first gets another prompt and is posted last (saved in the second)
  const next = [entry('p00-x', 'Make animation number zero, all squares.', { status: '2103900000000000000' }), ...many.slice(1), entry('zz-999', many[0].prompt, { status: '2103000000000000000' })];
  collection(t, next, 'c0ffee2');
  // the clock passes the deadline while the first chunk of items is written
  let now = 1_000;
  const clock = t.mock.method(Date, 'now', () => now);
  env.HARNESS_DB.beforeBatch = (statements) => {
    if (statements.some((st) => /INSERT INTO item_versions/.test(st.sql))) now = 10_000;
  };
  const first = await importPrompts(env, 'someone/prompts', CONFIG, 'c0ffee1', false, 5_000);
  assert.ok(first.remaining > 0);
  assert.equal(first.retired, 0);
  // the new entry took the prompt before its old holder moved on: not a copy all the same
  assert.deepEqual([item(env, 'zz-999').status, item(env, 'p00-x').latest_revision], ['public', 1]);
  clock.mock.restore();
  env.HARNESS_DB.beforeBatch = null;
  const second = await importPrompts(env, 'someone/prompts', CONFIG, 'c0ffee1');
  assert.equal(second.remaining, 0);
  const listed = env.HARNESS_DB.rows("SELECT name, listed_reasons FROM items WHERE kind = 'prompt' AND status != 'public'");
  assert.deepEqual(listed, []);
  assert.equal(env.HARNESS_DB.rows("SELECT COUNT(*) AS n FROM items WHERE status = 'public'")[0].n, 46);
});
