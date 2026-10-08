/**
 * Ring cards: a holder shares their ring at /ring/<number>/, and its
 * picture serves link previews.
 *
 *   GET    /api/me/card       the signed-in holder's card and their choices
 *   PUT    /api/me/card       share it, or change what it shows
 *   DELETE /api/me/card       stop sharing it
 *   GET    /api/me/card.jpg   the holder's card as a picture, as they set it up, shared or not
 *   GET    /api/rings/<number>/card-<lang>-<version>.jpg   a shared card's picture
 */
import { Hono, type Context } from 'hono';
import type { CardLang, RingCard } from '../../src/lib/ring-card';
import { audit } from '../audit';
import { avatarKey, copyAvatar } from '../avatars';
import { later } from '../context';
import { edgeCache, forCache, fromCache } from '../harness/cache';
import { fetchFallbacks } from './fonts';
import type { CardSources } from './render';
import { cardAvatar, cardImagePath, cardSettings, cardVersion, publicCard, shareCard, sharedCard, unshareCard, type CardSettings } from './store';

/** The signed-in user, as far as cards are concerned. */
export interface SessionUser {
  id: string;
  number: number;
  name: string;
  image: string | null;
  /** when the account was made, ISO */
  createdAt: string;
}

type C = Context<{ Bindings: Env }>;

/** Rendered pictures of a shared card are kept a month at each Cloudflare location, browsers ten minutes. */
const SHARED_IMAGE_CACHE = 'public, max-age=600, s-maxage=2592000';

const lang = (value: string | undefined): CardLang => (value === 'zh' ? 'zh' : 'en');

/** The holder's card and their choices, as the account dialog shows them. */
const holderCard = (user: SessionUser, settings: CardSettings) => ({
  number: user.number,
  name: user.name,
  image: cardAvatar(user.image, user.id),
  since: user.createdAt,
  ...settings,
});

/** Where the renderer finds what it draws: the site's files, this holder's picture, Google's fonts. */
function sources(c: C): CardSources {
  return {
    async asset(path) {
      // the file by its path alone: a revision in the address is for browsers' caches
      const url = new URL(path, c.req.url);
      url.search = '';
      const res = await c.env.ASSETS.fetch(new Request(url));
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async avatar(href) {
      const key = avatarKey(href);
      const object = key ? await c.env.MEDIA.get(key) : null;
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    fallbacks: (chars) => fetchFallbacks(chars),
  };
}

/** Rendering costs a good fraction of a second: a few a minute per address. */
async function mayRender(c: C): Promise<boolean> {
  const { success } = await c.env.RING_LIMIT.limit({ key: c.req.header('cf-connecting-ip') ?? 'local' });
  return success;
}

async function render(c: C, card: RingCard) {
  const { renderCard } = await import('./render');
  return renderCard(card, sources(c));
}

/**
 * Changes come from this site's own pages only. Browsers send Origin with
 * every PUT and DELETE, and another site's page cannot send these without
 * this one agreeing first (they are not simple requests); this makes sure.
 */
const fromSite = (c: C) => c.req.header('origin') === new URL(c.env.SITE_URL).origin;

export function ringRoutes(session: (c: C) => Promise<SessionUser | null>) {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/me/card', async (c) => {
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    // a picture still at the sign-in provider is copied here now, so the card can show it
    const image = cardAvatar(user.image, user.id) ?? (await copyAvatar(c.env, user).catch(() => null)) ?? user.image;
    return c.json({ card: holderCard({ ...user, image }, await cardSettings(c.env.DB, user.id)) });
  });

  app.put('/me/card', async (c) => {
    if (!fromSite(c)) return c.json({ error: 'forbidden' }, 403);
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) return c.json({ error: 'json_required' }, 415);
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    const body = (await c.req.json().catch(() => null)) as { showName?: unknown; showImage?: unknown } | null;
    if (typeof body?.showName !== 'boolean' || typeof body.showImage !== 'boolean') return c.json({ error: 'invalid_request' }, 400);
    // a picture can be shown only once there is one of ours
    const show = { name: body.showName, image: body.showImage && !!cardAvatar(user.image, user.id) };
    const first = await shareCard(c.env.DB, user.id, show);
    later(audit(c.env, first ? 'ring_card.shared' : 'ring_card.changed', user.id, show, c.req.raw));
    return c.json({ card: holderCard(user, { shared: true, showName: show.name, showImage: show.image }) });
  });

  app.delete('/me/card', async (c) => {
    if (!fromSite(c)) return c.json({ error: 'forbidden' }, 403);
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    const was = await cardSettings(c.env.DB, user.id);
    if (await unshareCard(c.env.DB, user.id)) later(audit(c.env, 'ring_card.unshared', user.id, undefined, c.req.raw));
    return c.json({ card: holderCard(user, { ...was, shared: false }) });
  });

  // ?name=1&image=1&lang=zh&download=1: the card as its holder sets it up, for saving
  app.get('/me/card.jpg', async (c) => {
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    if (!(await mayRender(c))) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    const q = c.req.query();
    const card: RingCard = {
      number: user.number,
      name: q.name === '1' ? user.name : null,
      image: q.image === '1' ? cardAvatar(user.image, user.id) : null,
      since: user.createdAt,
      lang: lang(q.lang),
    };
    const { jpeg } = await render(c, card);
    return c.body(jpeg, 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(q.download === '1' ? { 'Content-Disposition': `attachment; filename="spacering-srn-${user.number}.jpg"` } : {}),
    });
  });

  app.get('/rings/:number{[0-9]{5,9}}/:file{card-(?:en|zh)-[0-9a-f]{12}\\.jpg}', async (c) => {
    // The holder's choice is checked on every request, before any copy kept
    // here is served: a card no longer shared stops showing at once.
    const shared = await sharedCard(c.env.DB, Number(c.req.param('number')));
    if (!shared) return c.json({ error: 'not_found' }, 404);
    const [, l, asked] = /^card-(en|zh)-([0-9a-f]{12})\.jpg$/.exec(c.req.param('file'))!;
    const card = publicCard(shared, lang(l));
    const version = await cardVersion(card);
    // an address from before the card last changed: to what it shows now
    if (asked !== version) return c.redirect(cardImagePath(card, version), 302);

    const cache = edgeCache();
    const key = new Request(new URL(cardImagePath(card, version), c.req.url));
    const hit = await cache?.match(key);
    if (hit) return fromCache(hit);
    if (!(await mayRender(c))) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });

    const { jpeg, complete } = await render(c, card);
    const res = new Response(jpeg, {
      headers: {
        'Content-Type': 'image/jpeg',
        // left incomplete (a picture or fonts could not be had): try again soon, keep nothing
        'Cache-Control': complete ? SHARED_IMAGE_CACHE : 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    if (complete && cache) c.executionCtx.waitUntil(cache.put(key, forCache(res)));
    return res;
  });

  return app;
}
