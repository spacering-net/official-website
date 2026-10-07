import { zipSync, type Zippable } from 'fflate';
import { hex } from '../ids';

/** A file of a package: its path from the package root ('/'-separated, NFC), bytes, and executable bit. */
export interface PackageFile {
  path: string;
  data: Uint8Array;
  executable: boolean;
}

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** The file as text if it is valid UTF-8 without NUL bytes; null for anything else (treated as binary). */
export function asText(data: Uint8Array): string | null {
  if (data.subarray(0, 8192).includes(0)) return null;
  try {
    return strict.decode(data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// tar (GitHub's tarballs: ustar with pax headers)

export interface TarEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
  size: number;
  mode: number;
}

/** Bytes from a stream, as many as asked for at a time, without holding more than that. */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private have = 0;
  private done = false;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private maxBytes: number;
  total = 0;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number) {
    this.reader = reader;
    this.maxBytes = maxBytes;
  }

  private async fill(n: number): Promise<boolean> {
    while (this.have < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true;
      else if (value.length) {
        this.chunks.push(value);
        this.have += value.length;
        this.total += value.length;
        if (this.total > this.maxBytes) throw new Error('archive_too_large');
      }
    }
    return this.have >= n;
  }

  /** Exactly n bytes, or null at the end of the stream. */
  async read(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill(n))) return null;
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - at);
      out.set(c.subarray(0, k), at);
      at += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.have -= n;
    return out;
  }

  async skip(n: number): Promise<void> {
    while (n > 0) {
      if (!this.have && !(await this.fill(1))) throw new Error('archive_truncated');
      const c = this.chunks[0];
      if (c.length <= n) {
        this.chunks.shift();
        this.have -= c.length;
        n -= c.length;
      } else {
        this.chunks[0] = c.subarray(n);
        this.have -= n;
        n = 0;
      }
    }
  }
}

const ascii = new TextDecoder();
const field = (b: Uint8Array, from: number, len: number) => {
  const s = b.subarray(from, from + len);
  const end = s.indexOf(0);
  return ascii.decode(end < 0 ? s : s.subarray(0, end));
};
const octal = (b: Uint8Array, from: number, len: number) => {
  if (b[from] & 0x80) throw new Error('archive_entry_too_large'); // base-256 sizes: over 8 GB
  const s = field(b, from, len).trim();
  return s ? parseInt(s, 8) : 0;
};

/** pax records: "<length> <key>=<value>\n", repeated; the length counts bytes, itself included */
function paxRecords(body: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const utf8 = new TextDecoder();
  let at = 0;
  while (at < body.length) {
    let space = at;
    while (space < body.length && body[space] !== 0x20) space++;
    const len = parseInt(ascii.decode(body.subarray(at, space)), 10);
    if (!(len > 0) || at + len > body.length) break;
    const kv = utf8.decode(body.subarray(space + 1, at + len - 1));
    const eq = kv.indexOf('=');
    if (eq > 0) out.set(kv.slice(0, eq), kv.slice(eq + 1));
    at += len;
  }
  return out;
}

/**
 * Read a tar stream entry by entry, calling `onEntry` for each. When it returns
 * true for a file, the file's bytes are read and passed to `onFile`; anything
 * else is skipped without being held in memory. `maxBytes` caps the whole
 * stream, so a huge or endless archive fails instead of running on.
 */
export async function readTar(
  stream: ReadableStream<Uint8Array>,
  onEntry: (entry: TarEntry) => boolean,
  onFile: (entry: TarEntry, data: Uint8Array) => void | Promise<void>,
  maxBytes: number,
): Promise<void> {
  const reader = stream.getReader();
  const r = new ByteReader(reader, maxBytes);
  let pax = new Map<string, string>();
  let longName: string | null = null;
  try {
    for (;;) {
      const h = await r.read(512);
      if (!h || h.every((x) => x === 0)) return;
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
      if (sum !== octal(h, 148, 8)) throw new Error('archive_corrupt');

      const flag = String.fromCharCode(h[156] || 48);
      const size = octal(h, 124, 12);
      const padded = Math.ceil(size / 512) * 512;

      if (flag === 'x' || flag === 'g' || flag === 'L') {
        const body = await r.read(padded);
        if (!body) throw new Error('archive_truncated');
        if (flag === 'x') pax = paxRecords(body.subarray(0, size));
        else if (flag === 'L') longName = field(body, 0, size);
        continue; // global headers (git's commit id) carry nothing we use
      }

      const prefix = field(h, 257, 6) === 'ustar' ? field(h, 345, 155) : '';
      const name = pax.get('path') ?? longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
      const entry: TarEntry = {
        path: name.replace(/^\.\//, ''),
        type: flag === '0' || flag === '7' ? 'file' : flag === '5' ? 'dir' : flag === '2' ? 'symlink' : flag === '1' ? 'hardlink' : 'other',
        size: pax.has('size') ? Number(pax.get('size')) : size,
        mode: octal(h, 100, 8),
      };
      pax = new Map();
      longName = null;
      const dataBytes = Math.ceil(entry.size / 512) * 512;

      if (entry.type === 'file' && onEntry(entry)) {
        const data = await r.read(dataBytes);
        if (!data) throw new Error('archive_truncated');
        await onFile(entry, data.subarray(0, entry.size));
      } else {
        if (entry.type !== 'file') onEntry(entry);
        await r.skip(entry.type === 'file' ? dataBytes : padded);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// zip

// already compressed: stored as they are
const STORED = /\.(png|jpe?g|gif|webp|zip|gz|tgz|bz2|xz|7z|woff2?|mp[34]|pdf)$/i;
// DOS time can't go earlier; every entry gets it, so the same files make the same zip
const EPOCH = new Date(1980, 0, 1);

/**
 * The package as one zip: files in path order, fixed times and permissions
 * (0755 or 0644), so the same files always make the same bytes and hash.
 */
export function buildZip(files: PackageFile[]): Uint8Array {
  const z: Zippable = {};
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    z[f.path] = [f.data, { level: STORED.test(f.path) ? 0 : 6, mtime: EPOCH, os: 3, attrs: ((f.executable ? 0o100755 : 0o100644) << 16) >>> 0 }];
  }
  return zipSync(z);
}

// ---------------------------------------------------------------------------
// R2

/**
 * Store a file under its hash: the same bytes in many versions are kept one
 * time. Written without looking first, which would cost a round trip per
 * file; writing it again stores the same bytes.
 */
export async function putBlob(bucket: R2Bucket, sha: string, data: Uint8Array): Promise<void> {
  await bucket.put(`blobs/${sha}`, data, { sha256: sha, httpMetadata: { contentType: 'application/octet-stream' } });
}

export async function putArchive(bucket: R2Bucket, sha: string, data: Uint8Array): Promise<void> {
  await bucket.put(`archives/${sha}.zip`, data, { sha256: sha, httpMetadata: { contentType: 'application/zip' } });
}
