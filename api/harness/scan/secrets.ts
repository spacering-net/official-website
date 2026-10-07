/**
 * Credentials an author left in their own package (docs: section 6): the
 * common key and token formats that GitHub's secret scanning also knows, and
 * long random values assigned to names like *_KEY, *_TOKEN, *_SECRET.
 * Findings say where, never what: the value itself is not kept anywhere.
 */

export interface SecretFinding {
  kind: string;
  path: string;
  line: number;
}

const FORMATS: [string, RegExp][] = [
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})\b/g],
  ['gitlab_token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['openai_key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}\b/g],
  ['anthropic_key', /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}\b/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack_token', /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/g],
  ['slack_webhook', /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g],
  ['discord_webhook', /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{60,}/g],
  ['stripe_key', /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['pypi_token', /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g],
  ['huggingface_token', /\bhf_[A-Za-z0-9]{34}\b/g],
  ['sendgrid_key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g],
  ['telegram_bot_token', /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/g],
  ['azure_storage_key', /AccountKey=[A-Za-z0-9+/=]{80,}/g],
  ['private_key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
];

// names that hold credentials
const CREDENTIAL_NAME = '[A-Za-z0-9_]*(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|secret|token)';
// NAME = "value", NAME: value, "name": "value"; the value whole, however long
const ASSIGNED = new RegExp(`(?<![A-Za-z0-9_])(${CREDENTIAL_NAME})["']?\\s*[:=]\\s*["']?([A-Za-z0-9+/_\\-.=~]{20,})`, 'gi');
const CREDENTIAL_FIELD = new RegExp(`^${CREDENTIAL_NAME}$`, 'i');
// what placeholders and references look like
const PLACEHOLDER = /your|example|sample|dummy|fake|placeholder|changeme|xxxx|\*\*\*|redacted|replace|insert|todo|env\.|environ|getenv|config\.|settings\.|process|secrets\.|vault/i;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

// a reference to a value elsewhere (random_id.tunnel.b64_std, settings.api.key), not a value
const REFERENCE = /^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+$/;
// Placeholders and references are short and wordy; past 64 characters a value is judged on its randomness
// alone, so a long token that happens to contain "your" or a dot is still a token.
const looksRandom = (v: string) =>
  (v.length > 64 || (!PLACEHOLDER.test(v) && !REFERENCE.test(v))) && /\d/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 3.5;
// a line that says it shows an example ("Example: token ..."), judged on its other words: every
// assignment (name and value) and every token-like run on the line is taken out first
const EXAMPLE = /example|sample|dummy|fake|placeholder|xxxx|0{8}/i;
const TOKENS = /[A-Za-z0-9+/_\-.=~]{20,}/g;
// a known-format token that documentation made up: AWS's AKIAIOSFODNN7EXAMPLE, or one filled with x or 0
const MADE_UP = /EXAMPLE$|x{8}|X{8}|0{8}/;

const lineAt = (text: string, index: number) => {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
};

const lineOf = (text: string, index: number) => {
  const end = text.indexOf('\n', index);
  return text.slice(text.lastIndexOf('\n', index) + 1, end < 0 ? text.length : end);
};

/** Credentials in a text file: at most one finding per kind and line. */
export function scanSecrets(path: string, text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: string, index: number) => {
    const line = lineAt(text, index);
    const key = `${kind}:${line}`;
    if (!seen.has(key) && out.length < 50) {
      seen.add(key);
      out.push({ kind, path, line });
    }
  };
  for (const [kind, re] of FORMATS) for (const m of text.matchAll(re)) if (!MADE_UP.test(m[0])) add(kind, m.index ?? 0);
  for (const m of text.matchAll(ASSIGNED)) {
    if (looksRandom(m[2]) && !EXAMPLE.test(lineOf(text, m.index ?? 0).replace(ASSIGNED, ' ').replace(TOKENS, ' '))) add('assigned_secret', m.index ?? 0);
  }
  return out;
}

/** The text with every credential found replaced by "[redacted]", for metadata kept from a source that had one. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [, re] of FORMATS) out = out.replace(re, '[redacted]');
  return out.replace(ASSIGNED, (all, name: string, value: string) => (looksRandom(value) ? all.replace(value, '[redacted]') : all));
}

/**
 * Redact every string inside a parsed JSON value (objects and arrays walked),
 * so escaping cannot hide a credential. A field named like a credential
 * (API_KEY, client_secret, ...) holding a random-looking token is redacted
 * whole, as the same pair written as text would be found.
 */
export function redactDeep<T>(value: T, key?: string): T {
  if (typeof value === 'string') {
    // the same test the text check makes on "key: value", so what was found is what goes
    if (key && CREDENTIAL_FIELD.test(key) && [...`${key}: ${value}`.matchAll(ASSIGNED)].some((m) => looksRandom(m[2]))) return '[redacted]' as T;
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, k)])) as T;
  return value;
}

/**
 * Credentials in a JSON document, by line of its pretty-printed form. Quotes
 * inside strings are unescaped first, so an assignment written within a
 * string value is seen as it reads.
 */
export const scanJsonSecrets = (path: string, value: unknown): SecretFinding[] => scanSecrets(path, JSON.stringify(value, null, 2).replace(/\\"/g, '"'));
