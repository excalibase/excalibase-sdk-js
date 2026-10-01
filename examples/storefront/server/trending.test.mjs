import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTrending, parseProductId } from './trending.mjs';

function fakeRedis() {
  const scores = new Map();
  return {
    scores,
    async zIncrBy(key, increment, member) {
      assert.equal(key, 'storefront:views');
      const next = (scores.get(member) ?? 0) + increment;
      scores.set(member, next);
      return next;
    },
    async zRangeWithScores(key, start, stop, options) {
      assert.equal(key, 'storefront:views');
      assert.deepEqual(options, { REV: true });
      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(start, stop + 1)
        .map(([value, score]) => ({ value, score }));
    },
  };
}

test('views are counted per product and ranked', async () => {
  const redis = fakeRedis();
  const trending = createTrending(redis);
  assert.equal(await trending.recordView(3), 1);
  await trending.recordView(3);
  await trending.recordView(5);
  assert.deepEqual(await trending.top(2), [{ productId: 3, views: 2 }, { productId: 5, views: 1 }]);
});

test('top is capped', async () => {
  const redis = fakeRedis();
  const trending = createTrending(redis);
  for (let id = 1; id <= 30; id += 1) await trending.recordView(id);
  assert.equal((await trending.top(500)).length, 12);
});

test('parseProductId accepts positive integers only', () => {
  assert.equal(parseProductId('42'), 42);
  for (const bad of ['0', '-1', '1.5', 'abc', '', '99999999999', '1e3']) {
    assert.equal(parseProductId(bad), null, bad);
  }
});
