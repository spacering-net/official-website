import { asText, type PackageFile } from './files';
import { LIMITS } from './limits';

/** Something about a package's shape that stops it from being published. */
export interface FormatError {
  code: string;
  path?: string;
}

export interface RawFile {
  path: string;
  data: Uint8Array;
  executable?: boolean;
  /** anything but a regular file (a link, a device) is refused */
  type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
}

export interface Normalized {
  files: PackageFile[];
  /** files left out on purpose: OS clutter, and personal files (secrets, memories) */
  dropped: { path: string; reason: 'clutter' | 'personal' }[];
  errors: FormatError[];
}

// written by macOS and editors, never part of a package
const CLUTTER = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|(^|\/)__MACOSX\//;
// personal files: an author's environment, credentials or an agent's memory
const PERSONAL = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?|credentials\.json|USER\.md|MEMORY\.md|\.netrc|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519))$/;
// files that must be text, so must be valid UTF-8
const TEXT = /\.(md|markdown|txt|json|ya?ml|toml|ini|cfg|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|lua|sql|html?|css|scss|xml|csv|tsv)$/i;

const enc = new TextEncoder();

/**
 * Check a package's files against the format rules (docs: section 6) and put
 * them in normal form: paths in NFC with '/' separators, clutter and personal
 * files removed, and a lone wrapper directory around everything stripped
 * (people zip the folder, not its contents). Errors are listed, not thrown;
 * a package with any cannot be published.
 */
export function normalizePackage(input: RawFile[], { stripWrapper }: { stripWrapper: boolean }): Normalized {
  const errors: FormatError[] = [];
  const dropped: Normalized['dropped'] = [];
  let files: (RawFile & { path: string })[] = [];

  for (const f of input) {
    if (f.type === 'dir') continue;
    const path = f.path.normalize('NFC').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
    if (f.type && f.type !== 'file') {
      errors.push({ code: f.type === 'symlink' || f.type === 'hardlink' ? 'link' : 'special_file', path });
      continue;
    }
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((p) => p === '..' || p === '.')) {
      errors.push({ code: 'unsafe_path', path });
      continue;
    }
    if (/[\x00-\x1f\x7f]/.test(path)) {
      errors.push({ code: 'control_character_in_path', path: JSON.stringify(path) });
      continue;
    }
    if (CLUTTER.test(path)) {
      dropped.push({ path, reason: 'clutter' });
      continue;
    }
    files.push({ ...f, path });
  }

  if (stripWrapper) {
    const tops = new Set(files.map((f) => f.path.split('/')[0]));
    if (tops.size === 1 && files.every((f) => f.path.includes('/'))) {
      const top = [...tops][0];
      files = files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) }));
    }
  }

  const out: PackageFile[] = [];
  const seen = new Map<string, string>();
  let total = 0;
  for (const f of files) {
    if (PERSONAL.test(f.path)) {
      dropped.push({ path: f.path, reason: 'personal' });
      continue;
    }
    const folded = f.path.toLowerCase();
    if (seen.has(folded)) {
      errors.push({ code: 'duplicate_path', path: f.path });
      continue;
    }
    seen.set(folded, f.path);
    if (f.path.split('/').length - 1 > LIMITS.depth) errors.push({ code: 'too_deep', path: f.path });
    if (enc.encode(f.path).length > LIMITS.pathBytes) errors.push({ code: 'path_too_long', path: f.path });
    if (f.data.length > LIMITS.fileBytes) errors.push({ code: 'file_too_large', path: f.path });
    if (TEXT.test(f.path) && asText(f.data) === null) errors.push({ code: 'not_utf8', path: f.path });
    total += f.data.length;
    out.push({ path: f.path, data: f.data, executable: !!f.executable });
  }
  if (out.length > LIMITS.files) errors.push({ code: 'too_many_files' });
  if (total > LIMITS.totalBytes) errors.push({ code: 'too_large' });
  if (!out.length) errors.push({ code: 'empty' });
  return { files: out, dropped, errors };
}
