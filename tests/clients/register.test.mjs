import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

const script = new URL('../../scripts/register-codeg-client.mjs', import.meta.url);
test('registration generator creates restricted files and never prints the secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'srn-registration-'));
  try {
    const output = join(dir, 'new');
    const text = execFileSync(process.execPath, [script.pathname, '--owner-srn', '10000', '--public-url', 'https://codeg.example.com', '--output', output], { encoding: 'utf8' });
    const secret = readFileSync(join(output, 'client-secret'), 'utf8').trim();
    const sql = readFileSync(join(output, 'registration.sql'), 'utf8');
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!text.includes(secret));
    assert.ok(!sql.includes(secret));
    assert.ok(sql.includes(createHash('sha256').update(secret).digest('hex')));
    assert.ok(sql.includes('https://codeg.example.com/auth/srn/callback'));
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.equal(statSync(join(output, 'client-secret')).mode & 0o777, 0o600);
    const again = spawnSync(process.execPath, [script.pathname, '--owner-srn', '10000', '--public-url', 'https://codeg.example.com', '--output', output]);
    assert.notEqual(again.status, 0);
    for (const bad of ['http://codeg.example.com', 'https://codeg.example.com:8443', 'https://127.0.0.1', 'https://codeg.example.com/sub/', 'https://user:pass@codeg.example.com']) {
      const result = spawnSync(process.execPath, [script.pathname, '--owner-srn', '10000', '--public-url', bad, '--output', join(dir, 'bad')]);
      assert.notEqual(result.status, 0, bad);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('development desktop builds get a public loopback registration with no secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'srn-registration-'));
  try {
    const output = join(dir, 'dev');
    execFileSync(process.execPath, [script.pathname, '--desktop-id', 'codeg-desktop-dev', '--name', 'Codeg Dev', '--output', output], { encoding: 'utf8' });
    const sql = readFileSync(join(output, 'registration.sql'), 'utf8');
    assert.ok(sql.includes("'codeg-desktop-dev','desktop','Codeg Dev','http://127.0.0.1/auth/callback'"));
    assert.throws(() => statSync(join(output, 'client-secret')));
    for (const args of [['--desktop-id', 'codeg-desktop'], ['--desktop-id', 'codeg-desktop-Dev'], ['--desktop-id', 'codeg-desktop-dev', '--public-url', 'https://codeg.example.com', '--owner-srn', '10000']]) {
      assert.notEqual(spawnSync(process.execPath, [script.pathname, ...args, '--output', join(dir, 'bad')]).status, 0, args.join(' '));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
