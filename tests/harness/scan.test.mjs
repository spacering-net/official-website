import assert from 'node:assert/strict';
import { test } from 'node:test';
import { riskOf, scanStructure } from '../../api/harness/scan/content.ts';
import { skillPermissions } from '../../api/harness/scan/permissions.ts';
import { applyRules, logicalLines } from '../../api/harness/scan/rules.ts';
import { redactSecrets, scanSecrets } from '../../api/harness/scan/secrets.ts';

const enc = new TextEncoder();
const file = (path, content, executable = false) => ({ path, data: typeof content === 'string' ? enc.encode(content) : content, executable });

// credential-shaped values, assembled here so the repository never holds one
const fakeAws = ['AK', 'IA', 'Q7ZT3XKP9WLM2RVN'].join('');
const fakeGithub = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const randomish = ['x9Kq2', 'Lm7Zr', '4Tn8W', 'p3Vb6', 'Yc1Hs'].join('');

test('scanSecrets finds known formats and random values assigned to credential names', () => {
  const text = [`aws = "${fakeAws}"`, `token: ${fakeGithub}`, `API_KEY = "${randomish}"`, '-----BEGIN OPENSSH PRIVATE KEY-----'].join('\n');
  const kinds = scanSecrets('config.py', text).map((f) => `${f.kind}@${f.line}`);
  assert.ok(kinds.includes('aws_access_key@1'));
  assert.ok(kinds.includes('github_token@2'));
  assert.ok(kinds.includes('assigned_secret@3'));
  assert.ok(kinds.includes('private_key@4'));
});

test('scanSecrets leaves placeholders and references alone', () => {
  const text = [
    'API_KEY = "your-api-key-goes-here-123456"',
    'token = os.environ["GITHUB_TOKEN"]',
    'password: ${{ secrets.DB_PASSWORD }}',
    'SECRET_KEY = "changeme-changeme-changeme-1"',
    '  secret = random_id.tunnel_secret.b64_std',
    `  AWS_SECRET_KEY: ${['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('')}`,
    `Example: debug token: "${randomish}"`,
  ].join('\n');
  assert.deepEqual(scanSecrets('x.py', text), []);
});

test('redactSecrets keeps the text but not the value', () => {
  const out = redactSecrets(`{"env": {"KEY": "${fakeGithub}", "API_KEY": "${randomish}"}}`);
  assert.ok(!out.includes(fakeGithub) && !out.includes(randomish));
  assert.equal(JSON.parse(out).env.KEY, '[redacted]');
});

test('scanStructure flags hidden characters, binaries, archives and long comments', () => {
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0xff]);
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0xff]);
  const lockedZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 1, 0, 0, 0xff]);
  const findings = scanStructure([
    file('SKILL.md', `Read this.\n<!-- ${'note '.repeat(60)} -->\nok`),
    file('notes.md', `zero\u200bwidth`),
    file('tool', elf, true),
    file('extra.zip', zip),
    file('locked.zip', lockedZip),
    file('template.docx', zip),
    file('blank.md', `a${'\n'.repeat(260)}b`),
  ]);
  const got = findings.map((f) => `${f.check}:${f.severity}:${f.path}`).sort();
  assert.deepEqual(got, [
    'blank_lines:medium:blank.md',
    'document_container:low:template.docx',
    'encrypted_archive:high:locked.zip',
    'executable_binary:medium:tool',
    'hidden_characters:medium:notes.md',
    'long_html_comment:medium:SKILL.md',
    'nested_archive:medium:extra.zip',
  ]);
  assert.equal(riskOf(findings), 'high');
  assert.equal(riskOf([]), 'low');
});

test('logicalLines joins continued lines and keeps the first line number', () => {
  const lines = logicalLines('one \\\n  two\nthree |\nfour\nfive');
  assert.deepEqual(lines, [
    { line: 1, text: 'one  two' },
    { line: 3, text: 'three | four' },
    { line: 5, text: 'five' },
  ]);
});

test('a rule exclusion clears its own line only, and binaries are read as strings', () => {
  const rule = { id: 'r1', category: 'test', severity: 'high', scope: 'all', re: /zzfetch.*zzrun/i, exclude: /zzsafe/i, message: { en: 'x' } };
  const docRule = { ...rule, id: 'r2', scope: 'text', re: /zzmarker/ };
  const findings = applyRules(
    [rule, docRule],
    [
      file('a.sh', 'zzfetch thing \\\n | zzrun\nzzfetch zzrun zzsafe\nzzfetch again zzrun'),
      file('b.bin', new Uint8Array([0, 1, ...enc.encode('zzfetch-and-zzrun-inside'), 0])),
      file('c.py', 'zzmarker'),
      file('d.md', 'zzmarker'),
    ],
  );
  assert.deepEqual(
    findings.map((f) => `${f.rule}:${f.path}:${f.line ?? '-'}`),
    ['r1:a.sh:1', 'r1:a.sh:4', 'r1:b.bin:-', 'r2:d.md:1'],
  );
});

test('skillPermissions detects runtimes, installers, hosts, credentials and paths', () => {
  const p = skillPermissions(
    [
      file('SKILL.md', 'Run `pip install requests`, then see https://api.service.io/v1 and https://example.com/docs.'),
      file('scripts/run.py', 'import os\nkey = os.environ["SERVICE_API_KEY"]\nopen(os.path.expanduser("~/.config/tool"))'),
      file('scripts/go.sh', 'cat ~/.ssh/config'),
    ],
    ['Bash', 'Read'],
  );
  assert.deepEqual(p.detected.runsCode, ['python', 'shell']);
  assert.deepEqual(p.detected.installs, ['pip']);
  assert.deepEqual(p.detected.network, ['api.service.io']);
  assert.deepEqual(p.detected.secrets, ['SERVICE_API_KEY']);
  assert.deepEqual(p.detected.paths, ['~/.config', '~/.ssh']);
  assert.deepEqual(p.declared, { tools: ['Bash', 'Read'] });
});

test('credentials written inside JSON strings are found and redacted', async () => {
  const { redactDeep, scanJsonSecrets } = await import('../../api/harness/scan/secrets.ts');
  const doc = { name: 'x', description: `Set API_KEY="${randomish}" first.`, nested: [{ note: `token: ${fakeGithub}` }] };
  assert.deepEqual(scanJsonSecrets('server.json', doc).map((f) => f.kind).sort(), ['assigned_secret', 'assigned_secret', 'github_token']);
  const clean = JSON.stringify(redactDeep(doc));
  assert.ok(!clean.includes(randomish) && !clean.includes(fakeGithub));
});
