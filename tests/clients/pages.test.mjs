import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizationPage } from '../../api/clients/pages.ts';

test('only explicit authorization entry paths may render the protected page', () => {
  for (const prefix of ['', '/zh']) {
    for (const suffix of ['', '/', '/index.html', '.html']) {
      assert.deepEqual(authorizationPage(`${prefix}/authorize${suffix}`), { zh: !!prefix, accepted: true });
    }
  }
});

test('asset path aliases are recognized for rejection, not accepted as entries', () => {
  for (const prefix of ['', '/zh']) {
    for (const suffix of ['/index', '/index/', '//', '///index', '/./index', '/nested/../index', '.html/', '/index.html/']) {
      assert.deepEqual(authorizationPage(`${prefix}/authorize${suffix}`), { zh: !!prefix, accepted: false });
    }
  }
});

test('encoded prefixes, separators and nested encoding cannot escape classification', () => {
  for (const value of [
    '/%61uthorize', '/%2561uthorize/index', '/authorize%2findex', '/%2fauthorize//',
    '/some/%2e%2e/authorize/', '/%61%75%74%68%6f%72%69%7a%65', '/authorize%2ehtml',
    '/%61uthorize/%invalid', '/AUTHORIZE/index', '/authorize%5cindex',
  ]) assert.deepEqual(authorizationPage(value), { zh: false, accepted: false }, value);
  for (const value of ['/%7ah/authorize', '/zh/%61uthorize/index', '/%257a%2568%252fauthorize//']) {
    assert.deepEqual(authorizationPage(value), { zh: true, accepted: false }, value);
  }
});

test('other page namespaces keep their existing behavior', () => {
  for (const value of ['/', '/assistant/', '/zh/assistant/', '/harness/x', '/authorize/../assistant/', '/authorizex', '/api/client/v1/me']) {
    assert.equal(authorizationPage(value), null, value);
  }
});
