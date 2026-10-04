import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEED_IMAGES, seedProductImages, storageOrigin } from './images.mjs';

const DATA = 'http://api.example.test';
const PROJECT = 'proj-1';
const ID = 'kg2_0123456789abcdef0123456789';

// A fake data plane: records every call and answers like the platform.
function fakePlatform(products) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body });
    const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/system.generateUploadUrl')) return json({ data: { url: 'http://objects.example.test/staged?sig=1', storageId: ID, uploadId: 'upl_1' } });
    if (url.startsWith('http://objects.example.test/')) return new Response(null, { status: 200 });
    if (url.endsWith('/system.completeUpload')) return json({ data: ID });
    if (url.endsWith('/images.urls')) return json({ data: { [ID]: 'http://objects.example.test/p/x?sig=2' } });
    if (url.endsWith('/graphql')) {
      if (body.query.startsWith('{')) return json({ data: { publicProducts: products } });
      return json({ data: { updatePublicProducts: [{ id: 1 }] } });
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchImpl };
}

const target = (fetchImpl) => ({ dataUrl: DATA, projectId: PROJECT, publishableKey: 'esk_pub_x', token: 'staff-token', fetchImpl });
const readImage = async () => new Uint8Array([137, 80, 78, 71]);

test('a product without a picture gets one, uploaded as staff through the upload functions', async () => {
  const name = Object.keys(SEED_IMAGES)[0];
  const { calls, fetchImpl } = fakePlatform([{ id: 1, name, image_id: null }, { id: 2, name: 'Not seeded', image_id: null }]);
  const seeded = await seedProductImages(target(fetchImpl), readImage);
  assert.equal(seeded, 1);

  const mint = calls.find((c) => c.url === `${DATA}/functions/v1/${PROJECT}/system.generateUploadUrl`);
  assert.deepEqual(mint.body, { args: { contentType: 'image/png', size: 4 } });
  assert.equal(mint.headers.Authorization, 'Bearer staff-token');
  assert.equal(mint.headers['X-Excalibase-Publishable-Key'], 'esk_pub_x');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.headers['Content-Type'], 'image/png');
  assert.equal(put.headers['Content-Length'], '4');
  const complete = calls.find((c) => c.url.endsWith('/system.completeUpload'));
  assert.deepEqual(complete.body, { args: { storageId: ID, uploadId: 'upl_1' } });
  const update = calls.filter((c) => c.url === `${DATA}/${PROJECT}/graphql`).at(-1);
  assert.match(update.body.query, /updatePublicProducts\(where: \{ id: \{ eq: 1 \} \}, input: \{ image_id: "kg2_0123456789abcdef0123456789" \}\)/);
});

test('a product that already has a picture is left alone', async () => {
  const name = Object.keys(SEED_IMAGES)[0];
  const { calls, fetchImpl } = fakePlatform([{ id: 1, name, image_id: ID }]);
  assert.equal(await seedProductImages(target(fetchImpl), readImage), 0);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('the store is told where pictures are served from', async () => {
  const { fetchImpl } = fakePlatform([{ id: 1, name: 'x', image_id: ID }]);
  assert.equal(await storageOrigin(target(fetchImpl)), 'http://objects.example.test');
});

test('no picture, no origin', async () => {
  const { fetchImpl } = fakePlatform([{ id: 1, name: 'x', image_id: null }]);
  assert.equal(await storageOrigin(target(fetchImpl)), null);
});
