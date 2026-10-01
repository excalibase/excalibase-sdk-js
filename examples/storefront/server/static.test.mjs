import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { contentTypeOf, resolveStatic } from './static.mjs';

const ROOT = path.resolve('/srv/dist');

test('a file under the root resolves', () => {
  assert.equal(resolveStatic(ROOT, '/assets/app.js'), path.join(ROOT, 'assets/app.js'));
  assert.equal(resolveStatic(ROOT, '/products/lamp.svg?v=2'), path.join(ROOT, 'products/lamp.svg'));
});

test('no request path resolves outside the root', () => {
  for (const bad of ['/../etc/passwd', '/assets/../../etc/passwd', '/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd']) {
    const file = resolveStatic(ROOT, bad);
    assert.ok(file === null || file.startsWith(ROOT + path.sep), `${bad} -> ${file}`);
  }
  assert.equal(resolveStatic(ROOT, '/a%00b'), null);
});

test('the root itself is the SPA entry', () => {
  assert.equal(resolveStatic(ROOT, '/'), path.join(ROOT, 'index.html'));
});

test('content types by extension', () => {
  assert.equal(contentTypeOf('a.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeOf('a.svg'), 'image/svg+xml');
  assert.equal(contentTypeOf('a.unknown'), 'application/octet-stream');
});
