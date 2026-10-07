/**
 * UUIDv7 (RFC 9562): 48 bits of Unix time in milliseconds, then random bits.
 * Ids sort by creation time, which keeps SQLite's indexes compact, and give
 * away nothing about how many rows there are (the ring number does that, on
 * purpose).
 */
export function uuidv7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  const hi = Math.floor(ms / 0x1_0000_0000); // the top 16 of the 48 bits
  const lo = ms >>> 0; // the bottom 32
  b[0] = (hi >>> 8) & 0xff;
  b[1] = hi & 0xff;
  b[2] = (lo >>> 24) & 0xff;
  b[3] = (lo >>> 16) & 0xff;
  b[4] = (lo >>> 8) & 0xff;
  b[5] = lo & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // RFC variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
