// The storefront's container: serves the built SPA, tells it which project to
// talk to (/config.js), and keeps product views in the project's private
// Redis (/api/views, /api/trending). The browser talks to the Excalibase data
// plane directly; this server never holds a user's token.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configScript, contentSecurityPolicy } from './config.mjs';
import { contentTypeOf, resolveStatic } from './static.mjs';
import { createTrending, parseProductId } from './trending.mjs';

const ROOT = path.resolve(process.env.STATIC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const PORT = Number(process.env.PORT || 8080);
const VIEW_PATH = /^\/api\/views\/([^/]+)$/;

async function connectRedis(url) {
  if (!url) return null;
  const { createClient } = await import('redis');
  // Commands fail at once while Redis is away instead of queueing, so a view
  // or a trending read answers 502 rather than hanging.
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
  });
  client.on('error', (err) => console.error(`redis: ${err.message}`));
  // Not awaited: the store serves pages while Redis comes up or comes back.
  client.connect().catch((err) => console.error(`redis: ${err.message}`));
  return client;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json' });

async function serveStatic(req, res, headers) {
  const file = resolveStatic(ROOT, req.url);
  const found = file && (await stat(file).catch(() => null));
  // Unknown paths get the SPA, which routes on the client.
  const target = found?.isFile() ? file : path.join(ROOT, 'index.html');
  const immutable = target.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    ...headers,
    'Content-Type': contentTypeOf(target),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

async function handleApi(req, res, trending) {
  if (!trending) return sendJson(res, 503, { error: 'redis_not_configured' });
  const view = req.url.match(VIEW_PATH);
  if (view && req.method === 'POST') {
    const productId = parseProductId(view[1]);
    if (productId === null) return sendJson(res, 400, { error: 'invalid_product_id' });
    return sendJson(res, 200, { productId, views: await trending.recordView(productId) });
  }
  if (req.url.startsWith('/api/trending') && req.method === 'GET') {
    const limit = Number(new URL(req.url, 'http://local').searchParams.get('limit') || 4);
    return sendJson(res, 200, { products: await trending.top(Number.isFinite(limit) ? limit : 4) });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

async function main() {
  const redis = await connectRedis(process.env.REDIS_URL);
  const trending = redis ? createTrending(redis) : null;
  const headers = {
    'Content-Security-Policy': contentSecurityPolicy(process.env),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/healthz') res.on('finish', () => console.log(`${req.method} ${req.url} ${res.statusCode}`));
    try {
      if (req.url === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
      if (req.url === '/config.js') {
        return send(res, 200, configScript(process.env), { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' });
      }
      if (req.url.startsWith('/api/')) return await handleApi(req, res, trending);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, HEAD' });
      return await serveStatic(req, res, headers);
    } catch (err) {
      console.error(`${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream_unavailable' });
      else res.destroy();
    }
  });
  server.listen(PORT, () => console.log(`storefront on :${PORT}, redis ${redis ? 'on' : 'off'}`));
  const stop = () => server.close(() => (redis ? redis.quit().catch(() => {}) : null));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
