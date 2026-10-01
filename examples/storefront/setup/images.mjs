// Product pictures live in the project's Storage, not in the store's image.
// The setup script uploads the sample pictures the way staff do in the store:
// signed in as the staff account, through the upload functions the store
// deploys (the same calls db.storage.uploadFile makes), then names the
// picture on the product with a GraphQL update staff are allowed.
import { HttpError } from './platform.mjs';

// Sample product name -> picture in setup/images.
export const SEED_IMAGES = {
  'Walnut desk lamp': 'lamp.png',
  'Felt desk mat': 'mat.png',
  'Brass pen': 'pen.png',
  'Pour-over kettle': 'kettle.png',
  'Ceramic mug': 'mug.png',
  'House blend, 250 g': 'beans.png',
  'Canvas tote': 'tote.png',
  'Laptop sleeve': 'sleeve.png',
  'Prototype monitor stand': 'stand.png',
};

async function json(response, what) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) throw new HttpError('POST', what, response.status, data);
  return data;
}

function dataPlane({ dataUrl, projectId, publishableKey, token, fetchImpl = fetch }) {
  const base = dataUrl.replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'X-Excalibase-Publishable-Key': publishableKey,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const fn = async (name, args) => {
    const body = await json(await fetchImpl(`${base}/functions/v1/${projectId}/${name}`, {
      method: 'POST', headers, body: JSON.stringify({ args }),
    }), name);
    if (body?.error) throw new Error(`${name}: ${body.error}`);
    return body?.data;
  };
  const graphql = async (query) => {
    const body = await json(await fetchImpl(`${base}/${projectId}/graphql`, {
      method: 'POST', headers, body: JSON.stringify({ query }),
    }), 'graphql');
    if (body?.errors) throw new Error(`graphql: ${JSON.stringify(body.errors)}`);
    return body.data;
  };
  return { fn, graphql, fetchImpl };
}

async function upload(plane, bytes, contentType) {
  const minted = await plane.fn('system.generateUploadUrl', { contentType, size: bytes.byteLength });
  const put = await plane.fetchImpl(minted.url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload refused by the object store (HTTP ${put.status})`);
  await plane.fn('system.completeUpload', { storageId: minted.storageId, uploadId: minted.uploadId });
  return minted.storageId;
}

// Uploads a picture for every sample product that has none; returns how many.
export async function seedProductImages(target, readImage) {
  const plane = dataPlane(target);
  const { publicProducts } = await plane.graphql('{ publicProducts(orderBy: { id: ASC }) { id name image_id } }');
  let seeded = 0;
  for (const product of publicProducts) {
    const file = SEED_IMAGES[product.name];
    if (!file || product.image_id) continue;
    const storageId = await upload(plane, await readImage(file), 'image/png');
    await plane.graphql(`mutation { updatePublicProducts(where: { id: { eq: ${Number(product.id)} } }, input: { image_id: ${JSON.stringify(storageId)} }) { id } }`);
    seeded += 1;
  }
  return seeded;
}

// The origin pictures are served from, for the store's Content-Security-Policy.
export async function storageOrigin(target) {
  const plane = dataPlane(target);
  const { publicProducts } = await plane.graphql('{ publicProducts(orderBy: { id: ASC }) { id name image_id } }');
  const id = publicProducts.find((product) => product.image_id)?.image_id;
  if (!id) return null;
  const urls = await plane.fn('images.urls', { storageIds: [id] });
  return urls?.[id] ? new URL(urls[id]).origin : null;
}
