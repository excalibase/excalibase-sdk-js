import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserConfig, configScript, contentSecurityPolicy } from './config.mjs';

const ENV = {
  EXCALIBASE_URL: 'https://api.example.test/',
  EXCALIBASE_PROJECT_ID: 'proj-abc',
  EXCALIBASE_ORG_SLUG: 'acme',
  EXCALIBASE_PUBLISHABLE_KEY: 'esk_pub_live_x',
  REDIS_PASSWORD: 'never-sent',
};

test('browserConfig carries only the public values the SPA needs', () => {
  assert.deepEqual(browserConfig(ENV), {
    configured: true,
    url: 'https://api.example.test',
    projectId: 'proj-abc',
    orgSlug: 'acme',
    publishableKey: 'esk_pub_live_x',
  });
});

test('browserConfig says the store is not set up while a value is missing', () => {
  assert.deepEqual(browserConfig({ ...ENV, EXCALIBASE_PUBLISHABLE_KEY: '' }), { configured: false });
});

test('configScript cannot be broken out of with a closing script tag', () => {
  const script = configScript({ ...ENV, EXCALIBASE_ORG_SLUG: '</script><script>alert(1)</script>' });
  assert.ok(script.startsWith('window.__STOREFRONT__ = '));
  assert.ok(!script.includes('</script>'));
  assert.ok(!script.includes('never-sent'));
});

test('the content security policy allows the data plane over https and wss only', () => {
  const policy = contentSecurityPolicy(ENV);
  assert.match(policy, /connect-src 'self' https:\/\/api\.example\.test wss:\/\/api\.example\.test;/);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
});

test('a plain-http data plane gets ws, and no data plane leaves connect-src to self', () => {
  assert.match(contentSecurityPolicy({ ...ENV, EXCALIBASE_URL: 'http://api.local:8080' }), /connect-src 'self' http:\/\/api\.local:8080 ws:\/\/api\.local:8080;/);
  assert.match(contentSecurityPolicy({}), /connect-src 'self';/);
});

test('pictures and uploads may use the project storage origin, and nothing else', () => {
  const policy = contentSecurityPolicy({ ...ENV, EXCALIBASE_STORAGE_ORIGIN: 'https://files.example.test' });
  assert.match(policy, /img-src 'self' data: https:\/\/files\.example\.test;/);
  assert.match(policy, /connect-src 'self' https:\/\/api\.example\.test wss:\/\/api\.example\.test https:\/\/files\.example\.test;/);
  assert.match(contentSecurityPolicy(ENV), /img-src 'self' data:;/);
});

test('a storage origin that is not an http(s) origin is left out', () => {
  for (const value of ['javascript:alert(1)', 'https://files.example.test/path', "https://x.test; script-src *", 'not a url']) {
    assert.match(contentSecurityPolicy({ ...ENV, EXCALIBASE_STORAGE_ORIGIN: value }), /img-src 'self' data:;/, value);
  }
});
