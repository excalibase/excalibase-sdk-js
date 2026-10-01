import assert from 'node:assert/strict';
import { test } from 'node:test';
import { literalValue, mergeAppEnv, originOf, withOrigins } from './app-env.mjs';

test('mergeAppEnv keeps secrets and references, replaces and appends literals', () => {
  const existing = [
    { name: 'REDIS_URL', kind: 'secret', secret: { path: 'projects/p/apps/a', key: 'REDIS_URL' } },
    { name: 'EXCALIBASE_URL', kind: 'literal', value: 'http://old' },
    { name: 'DATABASE_URL', kind: 'reference', reference: { sourceKind: 'database', sourceName: 'db', variable: 'DATABASE_URL' } },
  ];
  const merged = mergeAppEnv(existing, { EXCALIBASE_URL: 'http://new', EXCALIBASE_PROJECT_ID: 'proj-1' });
  assert.deepEqual(merged, [
    existing[0],
    existing[2],
    { name: 'EXCALIBASE_PROJECT_ID', kind: 'literal', value: 'proj-1' },
    { name: 'EXCALIBASE_URL', kind: 'literal', value: 'http://new' },
  ]);
  assert.equal(existing[1].value, 'http://old', 'the input is not changed');
});

test('mergeAppEnv starts from nothing', () => {
  assert.deepEqual(mergeAppEnv(undefined, { A: 1 }), [{ name: 'A', kind: 'literal', value: '1' }]);
});

test('withOrigins adds new origins once and leaves a wildcard alone', () => {
  assert.deepEqual(withOrigins(['https://a.test'], ['https://b.test', 'https://a.test']), ['https://a.test', 'https://b.test']);
  assert.deepEqual(withOrigins(undefined, ['https://b.test']), ['https://b.test']);
  assert.deepEqual(withOrigins(['*'], ['https://b.test']), ['*']);
});

test('originOf drops the path and keeps a non-default port', () => {
  assert.equal(originOf('http://shop-p.apps.example.test/orders?x=1'), 'http://shop-p.apps.example.test');
  assert.equal(originOf('http://localhost:5176/'), 'http://localhost:5176');
});

test('literalValue reads only plain values', () => {
  const env = [{ name: 'K', kind: 'literal', value: 'v' }, { name: 'S', kind: 'secret', secret: {} }];
  assert.equal(literalValue(env, 'K'), 'v');
  assert.equal(literalValue(env, 'S'), null);
  assert.equal(literalValue(env, 'missing'), null);
});
