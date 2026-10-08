import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { drawable, fallbackFamilies, missing, readFont } from '../../api/rings/fonts.ts';
import { cardAvatar, cardSettings, cardVersion, publicCard, shareCard, sharedCard, unshareCard } from '../../api/rings/store.ts';
import { INK, inkLetters } from '../../src/lib/inscription.ts';
import { CARD_ART, CARD_ENGRAVED, CARD_WORDS, cardAddress, fitName, forgedOn, inkOnCard, numberSize, PAGE_FACES, ringCardSvg, xml } from '../../src/lib/ring-card.ts';
import { STILL } from '../../src/lib/ring-card-still.ts';
import { ACCOUNT_MIGRATIONS, D1 } from '../harness/env.mjs';

const font = (file) => readFont(new Uint8Array(readFileSync(new URL(`../../public/ring-card/fonts/${file}`, import.meta.url))));
const card = (over = {}) => ({ number: 10000, name: 'Ada Ring', image: null, since: '2026-10-07T03:12:00.000Z', lang: 'en', ...over });
const draw = (c) => ringCardSvg(c, { faces: PAGE_FACES, art: CARD_ART });

// ---------------------------------------------------------------------------
// the drawing

test('everything put into the drawing is escaped', () => {
  assert.equal(xml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  const svg = draw(card({ name: '<script>alert(1)</script> "quoted" & \'single\'' }));
  assert.ok(!svg.includes('<script'));
  assert.ok(svg.includes('&lt;script&gt;'));
  // in the label too (an attribute), and the art's address
  assert.match(svg, /aria-label="[^"<>]*&lt;script&gt;[^"<>]*&quot;quoted&quot;[^"<>]*"/);
  assert.ok(ringCardSvg(card(), { faces: PAGE_FACES, art: '/a"b.jpg' }).includes('href="/a&quot;b.jpg"'));
});

test('the card shows the holder only as far as it is given them', () => {
  const bare = draw(card({ name: null }));
  assert.ok(!bare.includes('Ada Ring'));
  assert.ok(!bare.includes(`>${CARD_WORDS.en.holder}<`));
  // the art and the engraved band, and no picture
  assert.equal((bare.match(/<image /g) ?? []).length, 2);
  const named = draw(card());
  assert.ok(named.includes('>Ada Ring<'));
  assert.ok(named.includes(`>${CARD_WORDS.en.holder}<`));
  const pictured = draw(card({ image: '/api/avatars/x/y.jpg' }));
  assert.equal((pictured.match(/<image /g) ?? []).length, 3);
  assert.ok(pictured.includes('href="/api/avatars/x/y.jpg"'));
  // the number, the date it was forged and where the card lives, always
  for (const svg of [bare, named, pictured]) {
    assert.ok(svg.includes('>10000<'));
    assert.ok(svg.includes(`>${CARD_WORDS.en.forged}<`) && svg.includes('>2026.10.07<'));
    assert.ok(svg.includes('spacering.net/ring/10000'));
  }
  const zh = draw(card({ lang: 'zh' }));
  assert.ok(zh.includes(`>${CARD_WORDS.zh.forged}<`) && zh.includes('>2026.10.07<'));
  assert.ok(zh.includes('spacering.net/zh/ring/10000'));
});

test('the band is lettered as the homepage letters it: centred, a letter and its spacing apart', () => {
  const letters = inkLetters('SRN 10000');
  const step = INK.size * (INK.advance + INK.tracking);
  for (let i = 1; i < letters.length; i++) assert.ok(Math.abs(letters[i].x - letters[i - 1].x - step) < 1e-9);
  const width = 9 * INK.size * INK.advance + 8 * INK.size * INK.tracking;
  assert.ok(Math.abs(letters[0].x - (INK.width - width) / 2) < 1e-9);
  // the longest number still fits the band's ink
  const longest = inkLetters('SRN 999999999');
  assert.ok(longest[0].x >= 0 && longest.at(-1).x + INK.size * INK.advance <= INK.width);
});

test("the holder's number is engraved inside the band, each letter set along it", () => {
  // the still's samples are where the ink's points land
  const { columns, rows, stepX, stepY } = STILL.grid;
  assert.equal(STILL.points.length, columns * rows * 2);
  assert.deepEqual(inkOnCard(0, 0), [STILL.points[0], STILL.points[1]]);
  const last = STILL.points.length - 2;
  assert.deepEqual(inkOnCard((columns - 1) * stepX, (rows - 1) * stepY).map((n) => Math.round(n * 1e6) / 1e6), [STILL.points[last], STILL.points[last + 1]]);

  const svg = draw(card({ number: 123456789 }));
  assert.ok(svg.includes(`href="${CARD_ENGRAVED}"`));
  const letters = [...svg.matchAll(/<text x="([^"]+)" y="([^"]+)" transform="matrix\(([^)]+)\)">([^<]+)<\/text>/g)];
  assert.equal(letters.map((m) => m[4]).join(''), 'SRN123456789');
  const { x, y, width, height } = STILL.engraved;
  for (const [, lx, ly, matrix] of letters) {
    const [a, b, c, d, e, f] = matrix.split(' ').map(Number);
    assert.ok([a, b, c, d, e, f].every(Number.isFinite), matrix);
    // the letter's middle lands on the part of the card the inked still covers
    const [mx, my] = [Number(lx) + (INK.size * INK.advance) / 2, Number(ly) - INK.size * 0.35];
    const [px, py] = [a * mx + c * my + e, b * mx + d * my + f];
    assert.ok(px > x && px < x + width && py > y && py < y + height, `${px}, ${py}`);
  }
  // and only through the mask
  assert.match(svg, /<image href="[^"]+engraved\.jpg[^"]*" [^>]*mask="url\(#rc-ink\)"\/>/);
});

test('the date a ring was forged is its UTC day', () => {
  assert.equal(forgedOn('2026-10-07T23:59:59.000Z'), '2026.10.07');
  assert.equal(forgedOn('2027-01-02T00:00:00.000Z'), '2027.01.02');
  assert.equal(forgedOn('not a date'), '');
  assert.equal(cardAddress({ number: 10001, lang: 'zh' }), 'spacering.net/zh/ring/10001');
});

test('a long name is cut with an ellipsis; spaces and control characters are tidied', () => {
  assert.equal(fitName('  Ada \n\t Ring\u0000 ', 20), 'Ada Ring');
  // nor can a name turn the text around
  assert.equal(fitName('\u202eAda\u202c \u2067Ring\u2069', 20), 'Ada Ring');
  const long = fitName('A very long name that will not fit on the card at all, really', 12);
  assert.ok(long.endsWith('…'));
  assert.ok(long.length < 30);
  assert.ok(!long.endsWith(' …'));
  // wide characters take more room than narrow ones
  assert.equal(fitName('汤新德汤新德汤新德', 4), '汤新德汤…');
  // an emoji made of several code points is cut whole or not at all
  assert.equal(fitName('👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧', 2), '👨‍👩‍👧👨‍👩‍👧…');
});

test('a longer number is set smaller, so it keeps clear of the ring', () => {
  assert.equal(numberSize(10000), 128);
  assert.equal(numberSize(99999), 128);
  assert.ok(numberSize(12345678) < 128);
  assert.ok(numberSize(12345678) * 8 * 0.54 <= 500);
  assert.ok(numberSize(999999999) * 9 * 0.54 <= 500);
});

// ---------------------------------------------------------------------------
// fonts

test("a font's character map says what it draws", () => {
  const jost = font('Jost-Regular.ttf');
  for (const ch of 'Aaé…ßŁ') assert.ok(jost.covers(ch.codePointAt(0)), ch);
  for (const ch of '汤한😀') assert.ok(!jost.covers(ch.codePointAt(0)), ch);
  const sc = font('NotoSansSC-Card.ttf');
  for (const ch of Object.values(CARD_WORDS.zh).join('')) assert.ok(sc.covers(ch.codePointAt(0)), ch);
  // the mono faces draw every printable ASCII character the card prints, the engraving included
  for (const mono of [font('IBMPlexMono-Regular.ttf'), font('IBMPlexMono-Medium.ttf')]) {
    for (let c = 0x21; c < 0x7f; c++) assert.ok(mono.covers(c), String.fromCharCode(c));
  }
});

test("what the card's fonts lack goes to the family for its script; invisible characters never count", () => {
  const jost = font('Jost-Regular.ttf');
  assert.deepEqual(missing('Ada‍️ Ring', [jost]), []);
  const lacking = missing('汤 김 さ 😀 ạ', [jost]);
  assert.deepEqual(lacking, ['汤', '김', 'さ', '😀', 'ạ']);
  assert.deepEqual(
    Object.fromEntries(fallbackFamilies(lacking)),
    { 'Noto Sans SC': '汤', 'Noto Sans KR': '김', 'Noto Sans JP': 'さ', 'Noto Emoji': '😀', 'Noto Sans': 'ạ' },
  );
  // what no font draws is left out rather than drawn as boxes
  assert.equal(drawable('Ada 汤 Ring', [jost]), 'Ada Ring');
  assert.equal(drawable('汤新德', [jost]), '');
});

// ---------------------------------------------------------------------------
// the database

function accounts() {
  const db = new D1(ACCOUNT_MIGRATIONS);
  const user = (id, number, image = null) =>
    db.sqlite
      .prepare('INSERT INTO users (id, number, name, email, image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, number, `User ${number}`, `${number}@example.com`, image, '2026-10-07T03:12:00.000Z', '2026-10-07T03:12:00.000Z');
  return { db, user };
}

test('a card is private until shared, and gone once sharing stops', async () => {
  const { db, user } = accounts();
  const id = '01900000-0000-7000-8000-000000000001';
  user(id, 10000);
  assert.deepEqual(await cardSettings(db, id), { shared: false, showName: false, showImage: false });
  assert.equal(await sharedCard(db, 10000), null);

  assert.equal(await shareCard(db, id, { name: true, image: false }), true);
  assert.equal(await shareCard(db, id, { name: false, image: false }), false);
  assert.deepEqual(await cardSettings(db, id), { shared: true, showName: false, showImage: false });
  const shared = await sharedCard(db, 10000);
  assert.equal(shared.userId, id);
  assert.equal(shared.since, '2026-10-07T03:12:00.000Z');

  assert.equal(await unshareCard(db, id), true);
  assert.equal(await unshareCard(db, id), false);
  assert.equal(await sharedCard(db, 10000), null);

  // and with the account
  await shareCard(db, id, { name: true, image: true });
  db.sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
  assert.deepEqual(db.rows('SELECT * FROM ring_cards'), []);
});

test('numbers that cannot be rings are not looked up', async () => {
  const { db } = accounts();
  for (const n of [9999, 1e10, 1.5, Number.NaN]) assert.equal(await sharedCard(db, n), null);
});

test("a shared card shows the holder's name and picture only as chosen, and only a picture kept here", async () => {
  const id = '01900000-0000-7000-8000-000000000001';
  const own = `/api/avatars/${id}/0123456789abcdef.jpg`;
  const base = { userId: id, number: 10000, name: 'Ada', image: own, since: '2026-10-07T03:12:00.000Z' };
  assert.deepEqual(publicCard({ ...base, showName: false, showImage: false }, 'en'), { number: 10000, name: null, image: null, since: base.since, lang: 'en' });
  assert.deepEqual(publicCard({ ...base, showName: true, showImage: true }, 'zh'), { number: 10000, name: 'Ada', image: own, since: base.since, lang: 'zh' });
  assert.equal(publicCard({ ...base, name: '\u202eAda', showName: true, showImage: false }, 'en').name, 'Ada');
  // a sign-in provider's address, or someone else's picture, is never shown
  assert.equal(cardAvatar('https://avatars.githubusercontent.com/u/1?v=4', id), null);
  assert.equal(cardAvatar('/api/avatars/01900000-0000-7000-8000-000000000002/0123456789abcdef.jpg', id), null);
  assert.equal(cardAvatar(own, id), own);
});

test("a card's version changes whenever its picture would", async () => {
  const a = await cardVersion(card());
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(await cardVersion(card()), a);
  for (const change of [{ name: null }, { name: 'Ada' }, { image: '/api/avatars/x/y.jpg' }, { lang: 'zh' }, { number: 10001 }]) {
    assert.notEqual(await cardVersion(card(change)), a, JSON.stringify(change));
  }
});
