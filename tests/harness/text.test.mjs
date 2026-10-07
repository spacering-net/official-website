import assert from 'node:assert/strict';
import { test } from 'node:test';
import { descriptionQuality, ftsQuery, languageOf, NAME_RE, namespacePublisher, segment, toName } from '../../api/harness/text.ts';

const tokens = (s) => s.split(/\s+/).filter(Boolean);

test('segment puts every Chinese character apart and leaves other text alone', () => {
  assert.deepEqual(tokens(segment('PDF表单填写')), ['PDF', '表', '单', '填', '写']);
  assert.equal(segment('plain english'), 'plain english');
});

test('languageOf tells Chinese from English', () => {
  assert.equal(languageOf('一个用于 GitHub 的 MCP 服务'), 'zh');
  assert.equal(languageOf('A GitHub MCP server'), 'en');
  assert.equal(languageOf('An MCP server for 小红书 (Xiaohongshu)'), 'en');
  assert.equal(languageOf(''), 'en');
});

test('ftsQuery quotes every word, requires all, and matches Chinese characters in a row', () => {
  assert.equal(ftsQuery('pdf forms'), '"pdf" "forms"*');
  assert.equal(ftsQuery('翻译'), '"翻 译"');
  assert.equal(ftsQuery('PDF表单 填写'), '"PDF" "表 单" "填 写"');
  // query syntax typed by someone is just words
  assert.equal(ftsQuery('a" OR b NEAR(c) *'), '"a" "OR" "b" "NEAR" "c"');
  assert.equal(ftsQuery('  -- ** '), null);
  assert.equal(ftsQuery('x'), '"x"');
});

test('names follow the Agent Skills rule', () => {
  assert.equal(toName('My_Server.v2'), 'my-server-v2');
  assert.equal(toName('--a--b--'), 'a-b');
  assert.equal(toName('数据'), 'item');
  assert.equal(toName('x'.repeat(80)).length, 64);
  for (const ok of ['pdf', 'pdf-forms', 'a1']) assert.ok(NAME_RE.test(ok), ok);
  for (const bad of ['-pdf', 'pdf-', 'pdf--forms', 'PDF', 'p_f', '']) assert.ok(!NAME_RE.test(bad), bad);
});

test('registry namespaces map to publishers', () => {
  assert.deepEqual(namespacePublisher('io.github.Foo-Bar'), { kind: 'github', login: 'Foo-Bar', handle: 'foo-bar' });
  assert.deepEqual(namespacePublisher('com.example'), { kind: 'domain', domain: 'example.com', handle: 'example.com' });
  assert.deepEqual(namespacePublisher('com.example.mcp'), { kind: 'domain', domain: 'mcp.example.com', handle: 'mcp.example.com' });
  assert.equal(namespacePublisher('nodots'), null);
  assert.equal(namespacePublisher('com.exa_mple'), null);
});

test('descriptionQuality lowers keyword lists and essays', () => {
  assert.equal(descriptionQuality('Fill in and sign PDF forms from a chat, keeping the original layout.'), 1);
  const list = Array.from({ length: 14 }, (_, i) => `word${i}`).join(', ');
  assert.ok(descriptionQuality(list) <= 0.5);
  assert.ok(descriptionQuality('A sentence that goes on. '.repeat(30)) < 1);
  assert.ok(descriptionQuality('#a #b #c #d #e #f tags') <= 0.6);
});
