import { hex, uuidv7 } from './ids';

/**
 * Append one entry to the audit log (sign-ins, new users, linked accounts).
 * The address is kept only as a keyed hash: enough to tell that two events
 * came from the same place, not where that was.
 */
export async function audit(env: Env, type: string, userId: string | null, data?: Record<string, unknown>, request?: Request) {
  const ip = request?.headers.get('cf-connecting-ip');
  const agent = request?.headers.get('user-agent')?.slice(0, 256) ?? null;
  await env.DB.prepare(
    'INSERT INTO audit_events (id, user_id, type, data, ip_hash, user_agent, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  )
    .bind(uuidv7(), userId, type, data ? JSON.stringify(data) : null, ip ? await keyedHash(ip, env.BETTER_AUTH_SECRET) : null, agent, new Date().toISOString())
    .run();
}

async function keyedHash(value: string, secret: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(`audit-ip:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value))).slice(0, 32);
}
