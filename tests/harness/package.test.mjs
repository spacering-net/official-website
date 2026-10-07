import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePackage } from '../../api/harness/package.ts';

const f = (path, text = 'x', extra = {}) => ({ path, data: new TextEncoder().encode(text), ...extra });
const codes = (r) => r.errors.map((e) => e.code);

test('a lone wrapper folder is stripped, clutter and personal files are dropped', () => {
  const r = normalizePackage(
    [f('pkg/SKILL.md'), f('pkg/.DS_Store'), f('pkg/__MACOSX/x'), f('pkg/.env'), f('pkg/.env.example'), f('pkg/MEMORY.md'), f('pkg/scripts/run.py')],
    { stripWrapper: true },
  );
  assert.deepEqual(r.files.map((x) => x.path).sort(), ['.env.example', 'SKILL.md', 'scripts/run.py']);
  assert.deepEqual(r.dropped.map((d) => `${d.reason}:${d.path}`).sort(), [
    'clutter:pkg/.DS_Store',
    'clutter:pkg/__MACOSX/x',
    'personal:.env',
    'personal:MEMORY.md',
  ]);
  assert.deepEqual(r.errors, []);
});

test('two top folders are left as they are', () => {
  const r = normalizePackage([f('a/SKILL.md'), f('b/x.md')], { stripWrapper: true });
  assert.deepEqual(r.files.map((x) => x.path).sort(), ['a/SKILL.md', 'b/x.md']);
});

test('unsafe paths, links, case clashes and bad text are refused', () => {
  const r = normalizePackage(
    [
      f('../escape.md'),
      f('/abs.md'),
      f('C:/win.md'),
      f('a/./b.md'),
      f('ok.md'),
      f('OK.md'),
      f('link', '', { type: 'symlink' }),
      f('dev', '', { type: 'other' }),
      { path: 'bad.md', data: new Uint8Array([0xff, 0xfe, 0x41]) },
      f('a\u0001b.md'),
    ],
    { stripWrapper: false },
  );
  assert.deepEqual(codes(r).sort(), [
    'control_character_in_path',
    'duplicate_path',
    'link',
    'not_utf8',
    'special_file',
    'unsafe_path',
    'unsafe_path',
    'unsafe_path',
    'unsafe_path',
  ]);
});

test('size, depth and count limits', () => {
  const deep = `${Array.from({ length: 12 }, (_, i) => `d${i}`).join('/')}/x.md`;
  assert.ok(codes(normalizePackage([f(deep)], { stripWrapper: false })).includes('too_deep'));
  const big = { path: 'big.bin', data: new Uint8Array(6 * 1024 * 1024) };
  assert.ok(codes(normalizePackage([big], { stripWrapper: false })).includes('file_too_large'));
  const many = Array.from({ length: 501 }, (_, i) => f(`f${i}.md`));
  assert.ok(codes(normalizePackage(many, { stripWrapper: false })).includes('too_many_files'));
  assert.deepEqual(codes(normalizePackage([], { stripWrapper: false })), ['empty']);
});
