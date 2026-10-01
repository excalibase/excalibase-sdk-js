// Product views counted in the project's private Redis: a sorted set of
// product id -> views, read back as "trending now".

const KEY = 'storefront:views';
const MAX_TOP = 12;

export function parseProductId(raw) {
  if (!/^[1-9][0-9]{0,8}$/.test(String(raw))) return null;
  return Number(raw);
}

export function createTrending(redis) {
  return {
    async recordView(productId) {
      return Number(await redis.zIncrBy(KEY, 1, String(productId)));
    },
    async top(limit) {
      const count = Math.max(1, Math.min(MAX_TOP, limit));
      const rows = await redis.zRangeWithScores(KEY, 0, count - 1, { REV: true });
      return rows.map((row) => ({ productId: Number(row.value), views: Number(row.score) }));
    },
  };
}
