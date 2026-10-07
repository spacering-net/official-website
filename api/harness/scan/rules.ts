import { asText, sha256, type PackageFile } from '../files';
import type { Localized } from '../text';
import { isScript, printableStrings, type Finding, type Severity } from './content';

/** A rule from the `rules` table, compiled. */
export interface Rule {
  id: string;
  category: string;
  severity: Severity;
  scope: 'all' | 'code' | 'script' | 'text';
  re: RegExp;
  exclude?: RegExp;
  message: Localized;
}

interface RuleRow {
  id: string;
  category: string;
  severity: Severity;
  scope: Rule['scope'];
  pattern: string;
  flags: string;
  exclude: string | null;
  message_en: string;
  message_zh: string;
}

let cached: { hash: string; rules: Rule[] } | undefined;

/**
 * The enabled rules, compiled, and a hash of them: each version records the
 * hash it was checked with, so a change to the rules shows which versions to
 * check again. The table is small and read every time, so a change applies
 * at once; patterns are compiled again only when the set changed. A pattern
 * that does not compile is skipped (and logged), not fatal.
 */
export async function loadRules(db: D1Database): Promise<{ rules: Rule[]; hash: string }> {
  const { results } = await db
    .prepare('SELECT id, category, severity, scope, pattern, flags, exclude, message_en, message_zh FROM rules WHERE enabled = 1 ORDER BY id')
    .all<RuleRow>();
  const hash = await sha256(JSON.stringify(results));
  if (cached?.hash === hash) return cached;
  const rules: Rule[] = [];
  for (const r of results) {
    try {
      // matched per line: no global or sticky state
      const flags = r.flags.replace(/[gy]/g, '');
      rules.push({
        id: r.id,
        category: r.category,
        severity: r.severity,
        scope: r.scope,
        re: new RegExp(r.pattern, flags),
        exclude: r.exclude ? new RegExp(r.exclude, flags) : undefined,
        message: { en: r.message_en, zh: r.message_zh },
      });
    } catch (err) {
      console.error(`[harness] rule ${r.id} does not compile`, err);
    }
  }
  cached = { hash, rules };
  return cached;
}

// how a line says "and the command goes on": shell, PowerShell, cmd, pipes and chains
const CONTINUES = /(\\|`|\^|\||&&|\|\|)\s*$/;
const MAX_LINE = 4000;

/**
 * A text as logical lines: continued lines joined to the line they continue,
 * so a command split across lines is checked whole. Each keeps the number of
 * its first line. Very long lines are checked in overlapping windows.
 */
export function logicalLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let joined = lines[i];
    while (CONTINUES.test(joined) && i + 1 < lines.length && joined.length < MAX_LINE) {
      joined = `${joined.replace(/\\\s*$/, '')} ${lines[++i].trim()}`;
    }
    if (joined.length <= MAX_LINE) out.push({ line: start + 1, text: joined });
    else for (let at = 0; at < joined.length; at += MAX_LINE - 200) out.push({ line: start + 1, text: joined.slice(at, at + MAX_LINE) });
  }
  return out;
}

const DOC = /\.(md|markdown|mdx|txt|rst)$/i;

function inScope(rule: Rule, path: string, binary: boolean): boolean {
  if (rule.scope === 'all') return true;
  if (binary) return false;
  if (rule.scope === 'text') return DOC.test(path);
  if (rule.scope === 'script') return isScript(path);
  return isScript(path) || DOC.test(path);
}

/**
 * Run the rules over every file, binary ones included (their printable
 * strings). A match counts unless the rule's exclusion matches the same
 * line: an exclusion clears that line only, never the rule. At most three
 * findings per rule and file, and two hundred in all.
 */
export function applyRules(rules: Rule[], files: PackageFile[]): Finding[] {
  const out: Finding[] = [];
  if (!rules.length) return out;
  for (const f of files) {
    const text = asText(f.data);
    const binary = text === null;
    const lines = logicalLines(binary ? printableStrings(f.data) : text);
    for (const rule of rules) {
      if (!inScope(rule, f.path, binary)) continue;
      let hits = 0;
      for (const l of lines) {
        if (!rule.re.test(l.text) || rule.exclude?.test(l.text)) continue;
        out.push({ check: 'rule', rule: rule.id, category: rule.category, severity: rule.severity, path: f.path, line: binary ? undefined : l.line });
        if (++hits >= 3 || out.length >= 200) break;
      }
      if (out.length >= 200) return out;
    }
  }
  return out;
}
