import { hex } from './ids';

/** Where GitHub and Google serve avatars; nothing else is fetched. */
const HOSTS = ['avatars.githubusercontent.com', 'lh3.googleusercontent.com'];
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 1_000_000;
const KEY = /^([0-9a-f-]{36})\/([0-9a-f]{16}\.(?:jpg|png|webp|gif))$/;

const allowed = (url: URL) => url.protocol === 'https:' && HOSTS.includes(url.hostname);

/**
 * Keep a copy of the sign-in provider's avatar in R2 and point the user at
 * it. Provider image hosts are often unreachable from mainland China, and
 * their links can change; ours are named by content, so they never do.
 */
export async function copyAvatar(env: Env, user: { id: string; image?: string | null }) {
  let url: URL;
  try {
    url = new URL(user.image ?? '');
  } catch {
    return;
  }
  if (!allowed(url)) return;
  // ask for a size that stays sharp at 2× without being large
  if (url.hostname === HOSTS[0]) url.searchParams.set('s', '256');
  else url.pathname = url.pathname.replace(/=s\d+(-c)?$/, '=s256-c');

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok || !allowed(new URL(res.url))) return;
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = TYPES[type];
  if (!ext || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return;
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return;

  const file = `${hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16)}.${ext}`;
  await env.MEDIA.put(`avatars/${user.id}/${file}`, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare('UPDATE users SET image = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(`/api/avatars/${user.id}/${file}`, new Date().toISOString(), user.id)
    .run();
}

/** GET /api/avatars/<user id>/<hash>.<ext>: named by content, so cached for good. */
export async function serveAvatar(env: Env, path: string): Promise<Response> {
  const m = KEY.exec(path);
  const object = m ? await env.MEDIA.get(`avatars/${m[1]}/${m[2]}`) : null;
  if (!object) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}
