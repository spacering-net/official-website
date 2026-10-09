import { asText, type PackageFile } from '../files';

export type Severity = 'low' | 'medium' | 'high';

/** One thing a check noticed. `check` names the built-in check, or `rule` the database rule. */
export interface Finding {
  check: string;
  severity: Severity;
  path?: string;
  line?: number;
  rule?: string;
  category?: string;
}

const SCRIPT = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|go|rs)$/i;
const DOCUMENT = /\.(docx|xlsx|pptx|odt|ods|odp|jar|apk|epub)$/i;

export const isScript = (path: string) => SCRIPT.test(path);

/** Instructions a model reads, by their names: SKILL.md, an assistant or prompt body, and the Markdown beside them. */
const isInstructionFile = (path: string) => /(^|\/)SKILL\.md$/i.test(path) || /^(AGENT|PROMPT|ASSISTANT)\.md$/i.test(path);

// zero-width space and word joiner, direction overrides and isolates, a byte-order mark past the start.
// Not the zero-width (non-)joiners: emoji sequences and some scripts need them.
const HIDDEN = /[\u200B\u2060\u202A-\u202E\u2066-\u2069]|(?!^)\uFEFF/;

function magic(data: Uint8Array): 'binary' | 'archive' | 'encrypted_archive' | null {
  const is = (...sig: number[]) => sig.every((x, i) => data[i] === x);
  // ELF, Mach-O (both byte orders, and universal), PE
  if (
    is(0x7f, 0x45, 0x4c, 0x46) ||
    is(0xfe, 0xed, 0xfa, 0xce) ||
    is(0xfe, 0xed, 0xfa, 0xcf) ||
    is(0xce, 0xfa, 0xed, 0xfe) ||
    is(0xcf, 0xfa, 0xed, 0xfe) ||
    is(0xca, 0xfe, 0xba, 0xbe) ||
    is(0x4d, 0x5a)
  ) {
    return 'binary';
  }
  // zip (bit 0 of its flags: encrypted), gzip, 7z, rar, xz, bzip2
  if (is(0x50, 0x4b, 0x03, 0x04)) return data[6] & 1 ? 'encrypted_archive' : 'archive';
  if (is(0x1f, 0x8b) || is(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || is(0x52, 0x61, 0x72, 0x21) || is(0xfd, 0x37, 0x7a, 0x58, 0x5a) || is(0x42, 0x5a, 0x68)) {
    return 'archive';
  }
  return null;
}

/** Runs of printable ASCII in a binary file, for the rule checks to read too. */
export function printableStrings(data: Uint8Array, min = 8, max = 200_000): string {
  const out: string[] = [];
  let run: number[] = [];
  let size = 0;
  for (const x of data) {
    if (x >= 0x20 && x < 0x7f) run.push(x);
    else {
      if (run.length >= min) {
        out.push(String.fromCharCode(...run));
        size += run.length;
        if (size > max) break;
      }
      run = [];
    }
  }
  if (run.length >= min) out.push(String.fromCharCode(...run));
  return out.join('\n');
}

/**
 * The built-in checks, on every file: things that hide content or code from a
 * reader, whatever the rules in the database say (docs: section 7). Huge
 * padding, endless lines and walls of blank lines; invisible and
 * direction-changing characters; long encoded blobs; executables, nested and
 * password-protected archives; long HTML comments in instructions.
 * `instructions`: every Markdown file of the package is instructions a model
 * reads, whatever it is called (an assistant's definition keeps its own name).
 */
export function scanStructure(files: PackageFile[], { instructions = false } = {}): Finding[] {
  const out: Finding[] = [];
  const isInstructions = (path: string) => isInstructionFile(path) || (instructions && /\.(md|markdown)$/i.test(path));
  for (const f of files) {
    const text = asText(f.data);
    if (text === null) {
      const kind = magic(f.data);
      if (kind === 'binary') out.push({ check: 'executable_binary', severity: 'medium', path: f.path });
      else if (kind === 'encrypted_archive') out.push({ check: 'encrypted_archive', severity: 'high', path: f.path });
      else if (kind === 'archive') {
        const doc = DOCUMENT.test(f.path);
        out.push({ check: doc ? 'document_container' : 'nested_archive', severity: doc ? 'low' : 'medium', path: f.path });
      }
      continue;
    }

    if (f.data.length > 256 * 1024) {
      const blank = text.length - text.replace(/\s/g, '').length;
      if (blank / text.length > 0.9) out.push({ check: 'padding', severity: 'medium', path: f.path });
    }
    const lines = text.split('\n');
    let blankRun = 0;
    let flaggedRun = false;
    let flaggedLong = false;
    let flaggedHidden = false;
    let flaggedEncoded = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        if (++blankRun > 200 && !flaggedRun) {
          out.push({ check: 'blank_lines', severity: 'medium', path: f.path, line: i + 1 });
          flaggedRun = true;
        }
        continue;
      }
      blankRun = 0;
      if (line.length > 5000 && !flaggedLong && !/\.(json|csv|tsv|svg|min\.js|min\.css|lock)$/i.test(f.path)) {
        out.push({ check: 'long_line', severity: 'low', path: f.path, line: i + 1 });
        flaggedLong = true;
      }
      if (!flaggedHidden && HIDDEN.test(line)) {
        out.push({ check: 'hidden_characters', severity: 'medium', path: f.path, line: i + 1 });
        flaggedHidden = true;
      }
      if (!flaggedEncoded && /[A-Za-z0-9+/]{400,}={0,2}/.test(line) && !/data:[\w/+.-]+;base64,/.test(line)) {
        out.push({ check: 'encoded_blob', severity: isScript(f.path) || isInstructions(f.path) ? 'medium' : 'low', path: f.path, line: i + 1 });
        flaggedEncoded = true;
      }
    }
    if (/\.(md|markdown|mdx)$/i.test(f.path)) {
      for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
        if (m[1].trim().length < 200) continue;
        const line = text.slice(0, m.index).split('\n').length;
        out.push({ check: 'long_html_comment', severity: isInstructions(f.path) ? 'medium' : 'low', path: f.path, line });
        break;
      }
    }
  }
  return out;
}

/** The highest severity among findings: the version's risk. */
export function riskOf(findings: { severity: Severity }[]): Severity {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.some((f) => f.severity === 'medium')) return 'medium';
  return 'low';
}
