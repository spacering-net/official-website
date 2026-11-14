import { hex } from '../ids';

export const SCOPE = 'profile:read';
export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export const grantFor = (kind: string) => (kind === 'desktop' ? 'srn-desktop-code-v1' : 'srn-web-code-v1');
export const randomValue = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
export const hash = async (value: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
export const challenge = async (verifier: string) => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};
export const opaque = (v: unknown, min = 43, max = 128): v is string => typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

/** Release and development desktop builds are separate public clients. */
export const DESKTOP_ID = /^codeg-desktop(?:-[a-z0-9]{1,24})?$/;
export const WEB_ID = /^codeg-web-[A-Za-z0-9_-]{16,128}$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})(\/[A-Za-z0-9/_-]{1,64})$/;

/**
 * The exact address a request may return to. A Web client has one registered
 * HTTPS address. A desktop client listens on a loopback port it picks for
 * each sign-in (RFC 8252 section 7.3), so only the port may differ from the
 * registered `http://127.0.0.1/<path>`.
 */
export function redirectAllowed(registration: { client_type: string; redirect_uri: string }, uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  if (registration.client_type === 'web') return uri === registration.redirect_uri;
  const match = LOOPBACK.exec(uri);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1024 && port <= 65535 && registration.redirect_uri === `http://127.0.0.1${match[2]}`;
}

/** Anonymous traffic: a Workers Rate Limiting binding, which writes nothing to D1. */
export async function allowed(binding: RateLimit, key: string): Promise<boolean> {
  return (await binding.limit({ key })).success;
}
export const displayText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);

/** Flat JSON only: rejecting duplicate names before JSON.parse avoids ambiguous bindings. */
export async function objectBody(request: Request, allowed: string[]): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\s*(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return null; }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    const result: Record<string, unknown> = Object.create(null);
    let at = 0;
    const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
    const take = (char: string) => { ws(); if (text[at] !== char) throw new Error('json'); at++; };
    const stringToken = () => {
      ws();
      const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(at));
      if (!match) throw new Error('json');
      at += match[0].length;
      return JSON.parse(match[0]) as string;
    };
    take('{'); ws();
    if (text[at] !== '}') while (true) {
      const key = stringToken();
      if (!allowed.includes(key) || Object.hasOwn(result, key)) return null;
      take(':'); ws();
      if (text[at] === '"') result[key] = stringToken();
      else {
        const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
        if (!match) return null;
        at += match[0].length;
        result[key] = JSON.parse(match[0]);
      }
      ws();
      if (text[at] !== ',') break;
      at++;
    }
    take('}'); ws();
    return at === text.length ? result : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

/**
 * Precise shared windows in D1, only after the caller has authenticated (a
 * website session, a Web client's secret), so anonymous traffic cannot turn
 * into writes on the accounts database.
 */
export async function limited(env: Env, category: string, identity: string, limit: number): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const keyHash = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`client-rate:${category}:${identity}`)));
  const row = await env.DB.prepare(`INSERT INTO client_rate_limits (key_hash, window_start, hits)
    VALUES (?1, CAST(unixepoch('now') / 60 AS INTEGER), 1)
    ON CONFLICT(key_hash) DO UPDATE SET
      hits = CASE WHEN window_start = excluded.window_start THEN hits + 1 ELSE 1 END,
      window_start = excluded.window_start RETURNING hits`).bind(keyHash).first<{ hits: number }>();
  return !row || row.hits > limit;
}
