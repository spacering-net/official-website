import { hex } from './ids';

/** Where GitHub and Google serve avatars; nothing else is fetched. */
const HOSTS = ['avatars.githubusercontent.com', 'lh3.googleusercontent.com'];
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 1_000_000;
const KEY = /^([0-9a-f-]{36})\/([0-9a-f]{16}\.(?:jpg|png|webp|gif))$/;

const allowed = (url: URL) => url.protocol === 'https:' && HOSTS.includes(url.hostname);

/** Where in R2 the picture at one of this site's /api/avatars/ addresses is; null for any other address. */
export function avatarKey(href: string): string | null {
  const m = href.startsWith('/api/avatars/') ? KEY.exec(href.slice('/api/avatars/'.length)) : null;
  return m ? `avatars/${m[1]}/${m[2]}` : null;
}

/** The R2 key of a user's own picture: one kept here under their id, never anyone else's. */
export function ownAvatarKey(href: string | null | undefined, userId: string): string | null {
  const key = href ? avatarKey(href) : null;
  return key?.startsWith(`avatars/${userId}/`) ? key : null;
}

/**
 * Keep a picture in R2 under a name of its own, never used for anything
 * else, and give its address. A picture that replaces another is always a
 * new file, so deleting the one before can never take a newer one with it,
 * whatever order two tabs' requests finish in.
 */
export async function keepPicture(env: Env, userId: string, bytes: ArrayBuffer | Uint8Array, type: string): Promise<string> {
  const file = `${hex(crypto.getRandomValues(new Uint8Array(8)).buffer)}.${TYPES[type]}`;
  await env.MEDIA.put(`avatars/${userId}/${file}`, bytes, { httpMetadata: { contentType: type } });
  return `/api/avatars/${userId}/${file}`;
}

const u32be = (b: Uint8Array, at: number) => b[at] * 2 ** 24 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));

/**
 * What a picture someone sends is, from its own first bytes (never from what
 * it says it is): PNG, JPEG or WebP, and its size in pixels. Null for
 * anything else, or for a header that does not hold together.
 */
export function imageInfo(b: Uint8Array): { type: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number } | null {
  // PNG: the signature, then IHDR first, with the width and height
  if (b.length >= 24 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) && ascii(b, 12, 'IHDR')) {
    return { type: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  // WebP: a RIFF of WEBP, lossy (VP8), lossless (VP8L) or extended (VP8X)
  if (b.length >= 30 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
      return { type: 'image/webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    }
    if (ascii(b, 12, 'VP8X')) return { type: 'image/webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
    return null;
  }
  // JPEG: from the start of image, marker by marker to the frame header
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      // padding, and the markers without a length
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        at += 2;
        continue;
      }
      // the image data, or its end, before any frame header
      if (marker === 0xd9 || marker === 0xda) return null;
      const length = u16be(b, at + 2);
      if (length < 2) return null;
      // SOF0 to SOF15, which are not DHT (C4), JPG (C8) or DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return at + 9 <= b.length ? { type: 'image/jpeg', width: u16be(b, at + 7), height: u16be(b, at + 5) } : null;
      }
      at += 2 + length;
    }
  }
  return null;
}

/**
 * Keep a copy of the sign-in provider's avatar in R2 and point the user at
 * it. Provider image hosts are often unreachable from mainland China, and
 * their links can change; ours are never reused, so they never do. The
 * user is pointed at the copy only while their picture is still the one it
 * was made from: one they set in the meantime (the console) stays, and the
 * copy is let go. Returns the copy's address, or null when there was nothing
 * to copy, it could not be had, or it came too late.
 */
export async function copyAvatar(env: Env, user: { id: string; image?: string | null }): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(user.image ?? '');
  } catch {
    return null;
  }
  if (!allowed(url)) return null;
  // ask for a size that stays sharp at 2× without being large
  if (url.hostname === HOSTS[0]) url.searchParams.set('s', '256');
  else url.pathname = url.pathname.replace(/=s\d+(-c)?$/, '=s256-c');

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok || !allowed(new URL(res.url))) return null;
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = TYPES[type];
  if (!ext || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null;
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return null;

  const href = await keepPicture(env, user.id, bytes, type);
  const { meta } = await env.DB.prepare('UPDATE users SET image = ?1, updated_at = ?2 WHERE id = ?3 AND image = ?4')
    .bind(href, new Date().toISOString(), user.id, user.image)
    .run();
  if (meta.changes) return href;
  await env.MEDIA.delete(avatarKey(href)!);
  return null;
}

/**
 * At every sign-in: a picture that is still the provider's is copied (the
 * first try, when the account was made, can fail). Nothing to do otherwise.
 */
export async function keepAvatar(env: Env, userId: string) {
  const user = await env.DB.prepare('SELECT image FROM users WHERE id = ?1').bind(userId).first<{ image: string | null }>();
  if (user) await copyAvatar(env, { id: userId, image: user.image });
}

/** GET /api/avatars/<user id>/<name>.<ext>: a name is never reused, so cached for good. */
export async function serveAvatar(env: Env, path: string): Promise<Response> {
  const key = avatarKey(`/api/avatars/${path}`);
  const object = key ? await env.MEDIA.get(key) : null;
  if (!object) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}
