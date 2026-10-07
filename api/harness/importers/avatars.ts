import { hex } from '../../ids';

/**
 * Publishers' pictures, kept in R2 beside the users' avatars and served from
 * /api/avatars/ (avatars.ts), so a page never loads them from elsewhere: a
 * GitHub account's avatar, or the icon a domain's site declares for home
 * screens. Each is looked for again after 30 days; a publisher without one
 * keeps its letter (components/harness/Avatar.astro).
 */

const BATCH = 60;
const AT_ONCE = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const AGAIN_MS = 30 * DAY_MS;
/** a look that got no clear answer is due again sooner */
const RETRY_MS = 3 * DAY_MS;
const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 300_000;
/** a smaller icon blurs at the size a publisher's page shows it */
export const MIN_PX = 64;
const HEADERS = { 'User-Agent': 'spacering.net-harness' };

interface Due {
  id: string;
  kind: 'github' | 'domain' | 'user';
  github_id: number | null;
  github_login: string | null;
  domain: string | null;
  avatar: string | null;
}

interface Picture {
  bytes: ArrayBuffer;
  type: string;
}

/**
 * Look for the pictures of one batch of publishers that are due: shown on
 * the shelves (public or listed) and not looked for in 30 days, in id order
 * from `after`. A picture is replaced when another is found, and dropped only
 * when its source answers that there is none; without a clear answer it stays,
 * and the publisher is looked at again in three days. A change applies only
 * over the picture this run read, so runs that overlap cannot undo each
 * other. Returns where the next batch starts, or null after the last.
 */
export async function refreshAvatars(env: Env, after: string): Promise<string | null> {
  const now = new Date();
  const { results } = await env.HARNESS_DB.prepare(
    `SELECT p.id, p.kind, p.github_id, p.github_login, p.domain, p.avatar FROM publishers p
      WHERE p.id > ?1 AND p.kind IN ('github', 'domain') AND (p.avatar_checked_at IS NULL OR p.avatar_checked_at < ?2)
        AND EXISTS (SELECT 1 FROM items i WHERE i.publisher_id = p.id AND i.status IN ('public', 'listed') AND i.visibility = 'public')
      ORDER BY p.id LIMIT ?3`,
  )
    .bind(after, new Date(now.getTime() - AGAIN_MS).toISOString(), BATCH)
    .all<Due>();

  const db = env.HARNESS_DB;
  const soon = new Date(now.getTime() - AGAIN_MS + RETRY_MS).toISOString();
  /** each publisher's update, and the file it leaves behind if it is the one that applies */
  const updates: { statement: D1PreparedStatement; replaced: string | null }[] = [];
  for (let i = 0; i < results.length; i += AT_ONCE) {
    await Promise.all(
      results.slice(i, i + AT_ONCE).map(async (p) => {
        // undefined: no clear answer this time (a timeout, a busy server)
        const found = await lookFor(p).catch(() => undefined);
        if (found === undefined) {
          // what there is stays, whatever another run has made it meanwhile; due again in three days
          updates.push({ statement: db.prepare('UPDATE publishers SET avatar_checked_at = ?1 WHERE id = ?2').bind(soon, p.id), replaced: null });
          return;
        }
        const avatar = found ? await keep(env, p, found) : null;
        updates.push({
          // only over what was read: a run that overlaps this one (a delivery repeated) may have changed it since
          statement: db.prepare('UPDATE publishers SET avatar = ?1, avatar_checked_at = ?2 WHERE id = ?3 AND avatar IS ?4').bind(avatar, now.toISOString(), p.id, p.avatar),
          // a picture replaced or gone: its file goes too (only ever under the publisher's own id)
          replaced: p.avatar && avatar !== p.avatar && p.avatar.startsWith(`/api/avatars/${p.id}/`) ? p.avatar.slice('/api/'.length) : null,
        });
      }),
    );
  }
  if (updates.length) {
    const done = await db.batch(updates.map((u) => u.statement));
    // a file is deleted once the update that stopped pointing at it has applied
    const gone = updates.flatMap((u, i) => (u.replaced && done[i].meta.changes > 0 ? [u.replaced] : []));
    if (gone.length) await env.MEDIA.delete(gone);
  }
  return results.length === BATCH ? results[results.length - 1].id : null;
}

/** Answers that say nothing about the picture: asked too soon, or a server in trouble. */
const unclear = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

/** The publisher's picture; null if it has none. Throws when that cannot be told. */
async function lookFor(p: Due): Promise<Picture | null> {
  if (p.kind === 'github' && (p.github_id || p.github_login)) {
    const url = p.github_id
      ? `https://avatars.githubusercontent.com/u/${p.github_id}?s=160&v=4`
      : `https://avatars.githubusercontent.com/${encodeURIComponent(p.github_login!)}?s=160`;
    const res = await get(url, 'image/*');
    if (!res.ok) await res.body?.cancel();
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`avatar: ${res.status}`);
    const picture = await asPicture(res);
    if (!picture) throw new Error('avatar: not a picture');
    return picture;
  }
  if (p.kind === 'domain' && p.domain) return siteIcon(p.domain);
  throw new Error('no source');
}

/**
 * The icon a domain's site declares for home screens (or the largest it
 * declares as big enough), else the conventional /apple-touch-icon.png.
 * Null only when every place asked answered that there is none; throws when
 * any of them gave no clear answer (no response, a busy or failing server).
 */
async function siteIcon(domain: string): Promise<Picture | null> {
  const page = await get(`https://${domain}/`, 'text/html');
  if (unclear(page.status)) {
    await page.body?.cancel();
    throw new Error(`site: ${page.status}`);
  }
  const base = page.url || `https://${domain}/`;
  const candidates = page.ok && (page.headers.get('content-type') ?? '').includes('html') ? declaredIcons(await readText(page, 256_000), base) : [];
  if (!page.bodyUsed) await page.body?.cancel();
  candidates.push(new URL('/apple-touch-icon.png', base).href);
  let open = false;
  for (const url of [...new Set(candidates)].slice(0, 4)) {
    try {
      const res = await get(url, 'image/*');
      if (unclear(res.status)) {
        open = true;
        await res.body?.cancel();
        continue;
      }
      const picture = res.ok ? await asPicture(res) : null;
      if (!res.bodyUsed) await res.body?.cancel();
      if (picture) return picture;
    } catch {
      open = true;
    }
  }
  if (open) throw new Error(`site: no clear answer about an icon for ${domain}`);
  return null;
}

const get = (url: string, accept: string) => fetch(url, { headers: { ...HEADERS, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(5000) });

/**
 * Icons a page declares in its <link> tags, the best first: home-screen icons
 * (180 pixels unless they say), then icons declared at least MIN_PX wide.
 * Drawings (SVG) and .ico files are left out; only https addresses are kept.
 */
export function declaredIcons(html: string, base: string): string[] {
  const end = html.search(/<\/head>/i);
  const head = end < 0 ? html : html.slice(0, end);
  const found: { href: string; size: number }[] = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name: string) => {
      const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
      return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    };
    const rel = (attr('rel') ?? '').toLowerCase().split(/\s+/);
    const href = attr('href')?.replace(/&amp;/g, '&').trim();
    if (!href) continue;
    const type = (attr('type') ?? '').toLowerCase();
    if (type.includes('svg') || type.includes('icon') || /\.(svg|ico)(?:[?#]|$)/i.test(href)) continue;
    const declared = Math.max(0, ...(attr('sizes') ?? '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
    let size: number;
    if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) size = declared || 180;
    else if (rel.includes('icon')) size = declared;
    else continue;
    if (size < MIN_PX) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol === 'https:') found.push({ href: url.href, size });
    } catch {
      /* not an address */
    }
  }
  return found.sort((a, b) => b.size - a.size).map((f) => f.href);
}

/** A response as a picture worth keeping: a raster image over https, small enough, and a PNG big enough. */
async function asPicture(res: Response): Promise<Picture | null> {
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!TYPES[type] || !res.url.startsWith('https:') || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await res.body?.cancel();
    return null;
  }
  const bytes = await readBytes(res, MAX_BYTES);
  if (!bytes) return null;
  if (type === 'image/png') {
    const size = pngSize(bytes);
    if (!size || size.width < MIN_PX || size.height < MIN_PX) return null;
  }
  return { bytes, type };
}

/** The width and height in a PNG's header, or null if these bytes are not a PNG. */
export function pngSize(bytes: ArrayBuffer): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const v = new DataView(bytes);
  // the signature, then the IHDR chunk
  if (v.getUint32(0) !== 0x89504e47 || v.getUint32(4) !== 0x0d0a1a0a || v.getUint32(12) !== 0x49484452) return null;
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** At most `max` bytes of a body; null if there are more. */
async function readBytes(res: Response, max: number): Promise<ArrayBuffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/** The start of a page's text, up to `max` bytes: enough for its head. */
async function readText(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (length >= max || /<\/head>/i.test(text)) {
      await reader.cancel();
      break;
    }
  }
  return text;
}

/** Keep a picture in R2 under the publisher's id, named by its content (unless it is the one kept already); returns its address. */
async function keep(env: Env, p: Due, picture: Picture): Promise<string> {
  const file = `${hex(await crypto.subtle.digest('SHA-256', picture.bytes)).slice(0, 16)}.${TYPES[picture.type]}`;
  const address = `/api/avatars/${p.id}/${file}`;
  if (address !== p.avatar) await env.MEDIA.put(`avatars/${p.id}/${file}`, picture.bytes, { httpMetadata: { contentType: picture.type } });
  return address;
}
