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

/**
 * Keep a copy of the sign-in provider's avatar in R2 and point the user at
 * it. Provider image hosts are often unreachable from mainland China, and
 * their links can change; ours are named by content, so they never do.
 * Returns the copy's address, or null when there was nothing to copy or it
 * could not be had.
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

  const file = `${hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16)}.${ext}`;
  const href = `/api/avatars/${user.id}/${file}`;
  await env.MEDIA.put(`avatars/${user.id}/${file}`, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare('UPDATE users SET image = ?1, updated_at = ?2 WHERE id = ?3').bind(href, new Date().toISOString(), user.id).run();
  return href;
}

/**
 * At every sign-in: a picture that is still the provider's is copied (the
 * first try, when the account was made, can fail). Nothing to do otherwise.
 */
export async function keepAvatar(env: Env, userId: string) {
  const user = await env.DB.prepare('SELECT image FROM users WHERE id = ?1').bind(userId).first<{ image: string | null }>();
  if (user) await copyAvatar(env, { id: userId, image: user.image });
}

/** GET /api/avatars/<user id>/<hash>.<ext>: named by content, so cached for good. */
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
