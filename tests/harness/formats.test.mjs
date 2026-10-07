import assert from 'node:assert/strict';
import { test } from 'node:test';
import { licenseFromText, spdx } from '../../api/harness/limits.ts';
import { excerpt, renderMarkdown } from '../../api/harness/markdown.ts';
import { isPublicHttps, packagesToPin, serverDedupeKey, serverPermissions, serverReasons, serverRuntime } from '../../api/harness/mcp.ts';
import { parseSkill } from '../../api/harness/skill.ts';

test('parseSkill reads a valid SKILL.md', () => {
  const r = parseSkill('---\nname: pdf-forms\ndescription: Fill PDF forms.\nallowed-tools: Read Write\nlicense: MIT\n---\n# PDF forms\nBody', 'pdf-forms');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.meta.name, 'pdf-forms');
  assert.deepEqual(r.meta.allowedTools, ['Read', 'Write']);
  assert.equal(r.body, '# PDF forms\nBody');
});

test('parseSkill refuses what the specification refuses, and flags the rest', () => {
  assert.deepEqual(parseSkill('no frontmatter', 'x').errors, ['frontmatter_missing']);
  assert.deepEqual(parseSkill('---\nname: [unclosed\n---\n', 'x').errors, ['frontmatter_invalid']);
  assert.deepEqual(parseSkill('---\nname: Bad_Name\ndescription: d\n---\n', 'x').errors, ['name_invalid']);
  assert.deepEqual(parseSkill(`---\nname: x\ndescription: ${'d'.repeat(1025)}\n---\n`, 'x').errors, ['description_too_long']);
  assert.deepEqual(parseSkill('---\nname: x\ndescription: d\nname: y\n---\n', 'x').errors, ['frontmatter_invalid']);
  const r = parseSkill('---\nname: x\ndescription: d\nuser-invocable: false\n---\n', 'other');
  assert.deepEqual(r.warnings.sort(), ['extra_fields', 'name_differs_from_folder']);
  assert.deepEqual(r.meta.extra, { 'user-invocable': false });
});

test('licenses are named from SPDX ids, common spellings and license texts', () => {
  assert.equal(spdx('mit'), 'MIT');
  assert.equal(spdx('Apache 2.0'), 'Apache-2.0');
  assert.equal(spdx('Proprietary. LICENSE.txt has complete terms'), null);
  assert.equal(licenseFromText('Apache License\n Version 2.0, January 2004'), 'Apache-2.0');
  assert.equal(licenseFromText('Permission is hereby granted, free of charge, to any person obtaining a copy'), 'MIT');
  assert.equal(licenseFromText('All rights reserved.'), null);
});

test('markdown is rendered without raw HTML, unsafe links or images', () => {
  const html = renderMarkdown('<b class="x">raw</b>\n\n[ok](https://a.io) [bad](javascript:void(0)) [rel](docs/x.md) ![img](https://a.io/i.png) ![local](i.png)');
  assert.ok(!html.includes('<b class'));
  assert.ok(html.includes('&lt;b class=&quot;x&quot;&gt;raw&lt;/b&gt;'));
  assert.ok(html.includes('<a href="https://a.io" rel="nofollow ugc noopener noreferrer" target="_blank">ok</a>'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('<span>rel</span>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('[img]</a>') && html.includes('<span>[local]</span>'));
  assert.equal(excerpt('# Title\n\n```sh\ncode\n```\nSome [link](x) text'), 'Title Some link text');
});

const server = (extra) => ({ name: 'io.github.someone/notes', description: 'Search and edit notes from your agent.', ...extra });

test('registry servers: runtime, dedupe key, reasons and permissions', () => {
  const npm = server({
    repository: { url: 'https://github.com/someone/notes' },
    packages: [{ registryType: 'npm', identifier: '@Some/Notes', version: '1.2.3', environmentVariables: [{ name: 'NOTES_TOKEN', isSecret: true }, { name: 'DEBUG' }] }],
  });
  assert.equal(serverRuntime(npm), 'node');
  assert.equal(serverDedupeKey(npm), 'npm:@some/notes');
  assert.deepEqual(serverReasons(npm, 'active'), []);
  assert.deepEqual(packagesToPin(npm), [{ registryType: 'npm', identifier: '@Some/Notes', version: '1.2.3', verified: 'pending' }]);
  assert.deepEqual(serverPermissions(npm, packagesToPin(npm)).detected.secrets, ['NOTES_TOKEN']);

  const remote = server({ remotes: [{ type: 'streamable-http', url: 'https://mcp.notes.io/mcp/' }] });
  assert.equal(serverRuntime(remote), 'remote');
  assert.equal(serverDedupeKey(remote), 'remote:mcp.notes.io/mcp');
  assert.deepEqual(serverReasons(remote, 'deprecated'), ['no_repository', 'deprecated']);
  assert.deepEqual(serverReasons(server({ description: 'x', remotes: [{ url: 'http://10.0.0.1/mcp' }], packages: [{ registryType: 'oci', identifier: 'a/b' }] })), [
    'no_repository',
    'no_description',
    'remote_not_public',
    'package_unverifiable',
  ]);
});

test('isPublicHttps refuses this machine, private networks and plain http', () => {
  for (const ok of ['https://mcp.example.org/x', 'https://8.8.8.8/']) assert.ok(isPublicHttps(ok), ok);
  for (const bad of ['http://mcp.example.org', 'https://localhost:3000', 'https://192.168.1.2', 'https://10.1.2.3', 'https://172.20.0.1', 'https://[::1]/', 'https://printer.local', 'https://user:pw@a.io', 'https://intranet']) {
    assert.ok(!isPublicHttps(bad), bad);
  }
});
