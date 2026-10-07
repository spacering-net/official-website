import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { buildZip, readTar, sha256 } from '../../api/harness/files.ts';
import { entry, paxRecord, tarball } from './env.mjs';

const enc = new TextEncoder();

const gzipStream = (bytes) => new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')).pipeThrough(new DecompressionStream('gzip'));

test('readTar reads files, long pax paths, and reports links without reading them', async () => {
  const long = `repo-abc123/skills/${'deep/'.repeat(30)}SKILL.md`;
  const bytes = tarball([
    entry('pax_global_header', paxRecord('comment', 'abc123'), 'g'),
    entry('repo-abc123/', '', '5', 0o755),
    entry('repo-abc123/run.sh', '#!/bin/sh\necho hi\n', '0', 0o755),
    entry('PaxHeader', paxRecord('path', long), 'x'),
    entry('ignored-name', 'long one'),
    entry('repo-abc123/link', '', '2'),
    entry('repo-abc123/skip.bin', 'not wanted'),
  ]);
  const seen = [];
  const kept = new Map();
  await readTar(
    gzipStream(bytes),
    (e) => {
      seen.push(`${e.type}:${e.path}`);
      return e.type === 'file' && !e.path.endsWith('.bin');
    },
    (e, data) => kept.set(e.path, { text: new TextDecoder().decode(data), mode: e.mode }),
    1 << 20,
  );
  assert.deepEqual(seen, ['dir:repo-abc123/', 'file:repo-abc123/run.sh', `file:${long}`, 'symlink:repo-abc123/link', 'file:repo-abc123/skip.bin']);
  assert.equal(kept.get('repo-abc123/run.sh').text, '#!/bin/sh\necho hi\n');
  assert.equal(kept.get('repo-abc123/run.sh').mode & 0o111, 0o111);
  assert.equal(kept.get(long).text, 'long one');
  assert.ok(!kept.has('repo-abc123/skip.bin'));
});

test('readTar stops at its byte limit and on a corrupt header', async () => {
  const bytes = tarball([entry('a.txt', 'x'.repeat(5000))]);
  await assert.rejects(readTar(gzipStream(bytes), () => true, () => {}, 2048), /archive_too_large/);
  const corrupt = tarball([entry('a.txt', 'hello')]);
  corrupt[0] ^= 0xff;
  await assert.rejects(readTar(gzipStream(corrupt), () => true, () => {}, 1 << 20), /archive_corrupt/);
});

test('buildZip makes the same bytes for the same files, in any order, and keeps the executable bit', async () => {
  const files = [
    { path: 'b/run.py', data: enc.encode('print(1)\n'), executable: true },
    { path: 'SKILL.md', data: enc.encode('---\nname: x\n---\n'), executable: false },
    { path: 'img.png', data: new Uint8Array([137, 80, 78, 71]), executable: false },
  ];
  const a = buildZip(files);
  const b = buildZip([...files].reverse());
  assert.equal(await sha256(a), await sha256(b));
  const back = unzipSync(a);
  assert.deepEqual(Object.keys(back).sort(), ['SKILL.md', 'b/run.py', 'img.png']);
  assert.equal(new TextDecoder().decode(back['b/run.py']), 'print(1)\n');
  // the central directory's external attributes: 0100755 for the script
  const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const modes = [];
  for (let i = 0; i < a.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) modes.push((view.getUint32(i + 38, true) >>> 16) & 0o777);
  }
  assert.deepEqual(modes.sort(), [0o644, 0o644, 0o755]);
});
