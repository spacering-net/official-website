import { hex } from '../../ids';
import { isPublicHttps } from '../mcp';
import { pngSize } from './avatars';

/**
 * Pictures of what items make (a prompt's results), copied from where their
 * sources name them into R2 (media/<sha256>) and served from
 * /api/harness/v1/media/, so pages show pictures from this site only. The
 * importers record the addresses (media table, only hosts a source's config
 * allows); this job looks for them a batch at a time. What an address
 * answers decides: a picture is kept; something else (a page saying there is
 * nothing there) is missing, looked for again in 30 days; no clear answer
 * (a timeout, a busy server) is failed, tried again in three.
 */

export const MEDIA_BATCH = 60;
const AT_ONCE = 6;
/** moving previews run to half a megabyte */
const MAX_BYTES = 1_000_000;
const MAX_SIDE = 4096;
const DAY_MS = 24 * 60 * 60 * 1000;
const HEADERS = { 'User-Agent': 'spacering.net-harness', Accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' };

export const MEDIA_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

export interface ImageInfo {
  type: string;
  width: number;
  height: number;
}

/** What a file is, by its first bytes, and its size in pixels: a WebP, PNG, JPEG or GIF; null for anything else. */
export function imageInfo(bytes: ArrayBuffer): ImageInfo | null {
  const v = new DataView(bytes);
  const n = bytes.byteLength;
  const ascii = (at: number, len: number) => (at + len <= n ? String.fromCharCode(...new Uint8Array(bytes, at, len)) : '');
  const u24 = (at: number) => v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    // the extended format (animations among it) gives the canvas, less one, in three bytes each
    if (chunk === 'VP8X' && n >= 30) return { type: 'image/webp', width: 1 + u24(24), height: 1 + u24(27) };
    if (chunk === 'VP8 ' && n >= 30 && v.getUint8(23) === 0x9d && v.getUint8(24) === 0x01 && v.getUint8(25) === 0x2a) {
      return { type: 'image/webp', width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8L' && n >= 25 && v.getUint8(20) === 0x2f) {
      const bits = v.getUint32(21, true);
      return { type: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  const png = pngSize(bytes);
  if (png) return { type: 'image/png', ...png };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return n >= 10 ? { type: 'image/gif', width: v.getUint16(6, true), height: v.getUint16(8, true) } : null;
  if (n >= 4 && v.getUint8(0) === 0xff && v.getUint8(1) === 0xd8 && v.getUint8(2) === 0xff) {
    // the segments, up to the frame header that gives the size
    let at = 2;
    while (at + 9 < n) {
      if (v.getUint8(at) !== 0xff) return null;
      const marker = v.getUint8(at + 1);
      if (marker === 0xff) {
        at++;
        continue;
      }
      const length = v.getUint16(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', width: v.getUint16(at + 7), height: v.getUint16(at + 5) };
      }
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  return null;
}

type Look = { status: 'ok'; bytes: ArrayBuffer; info: ImageInfo } | { status: 'missing' } | { status: 'failed' };

/** Answers that say nothing about the picture: asked too soon, or a server in trouble. */
const unclear = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

/** What one address answers. */
async function look(url: string): Promise<Look> {
  if (!isPublicHttps(url)) return { status: 'missing' };
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  } catch {
    return { status: 'failed' };
  }
  if (unclear(res.status)) {
    await res.body?.cancel();
    return { status: 'failed' };
  }
  // a picture is taken only from the host it was named at (a source's config allows that one), over public https
  const from = res.url || url;
  if (!res.ok || !res.body || !isPublicHttps(from) || new URL(from).hostname !== new URL(url).hostname || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await res.body?.cancel();
    return { status: 'missing' };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        return { status: 'missing' };
      }
      chunks.push(value);
    }
  } catch {
    return { status: 'failed' };
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  // what it is, by its bytes, whatever the answer called it (a missing picture can come back as a page)
  const info = imageInfo(bytes.buffer);
  if (!info || !info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE) return { status: 'missing' };
  return { status: 'ok', bytes: bytes.buffer, info };
}

/**
 * Look for one batch of the pictures that are due: never looked for, or
 * missing for 30 days, or failed for three; oldest first. Returns how many
 * were looked at (a full batch means there may be more).
 */
export async function fetchMedia(env: Env, limit = MEDIA_BATCH): Promise<number> {
  const db = env.HARNESS_DB;
  const now = Date.now();
  const { results } = await db
    .prepare(
      `SELECT url FROM media
        WHERE status = 'pending' OR (status = 'failed' AND checked_at < ?1) OR (status = 'missing' AND checked_at < ?2)
        ORDER BY created_at, url LIMIT ?3`,
    )
    .bind(new Date(now - 3 * DAY_MS).toISOString(), new Date(now - 30 * DAY_MS).toISOString(), limit)
    .all<{ url: string }>();
  const checkedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < results.length; i += AT_ONCE) {
    await Promise.all(
      results.slice(i, i + AT_ONCE).map(async ({ url }) => {
        const found = await look(url);
        if (found.status !== 'ok') {
          // a failed look leaves a picture kept before as it is
          statements.push(
            db
              .prepare("UPDATE media SET status = CASE WHEN status = 'ok' THEN 'ok' ELSE ?1 END, checked_at = ?2 WHERE url = ?3")
              .bind(found.status, checkedAt, url),
          );
          return;
        }
        const sha = hex(await crypto.subtle.digest('SHA-256', found.bytes));
        await env.HARNESS_FILES.put(`media/${sha}`, found.bytes, { httpMetadata: { contentType: found.info.type } });
        statements.push(
          db
            .prepare("UPDATE media SET status = 'ok', sha256 = ?1, type = ?2, width = ?3, height = ?4, size = ?5, checked_at = ?6 WHERE url = ?7")
            .bind(sha, found.info.type, found.info.width, found.info.height, found.bytes.byteLength, checkedAt, url),
        );
      }),
    );
  }
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return results.length;
}

/** Where a kept picture is served: /api/harness/v1/media/<sha256>.<ext>. */
export const mediaPath = (sha256: string, type: string) => `/api/harness/v1/media/${sha256}.${MEDIA_TYPES[type] ?? 'bin'}`;
