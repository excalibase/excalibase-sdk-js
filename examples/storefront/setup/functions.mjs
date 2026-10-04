// The store's functions, deployed by the setup script through the control
// plane's functions API. Two are the mutations db.storage.uploadFile calls by
// default; images.urls hands out short-lived links to product pictures.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'functions');
const RULES = 'storage-rules.ts';

export const FUNCTIONS = [
  { id: 'system.generateUploadUrl', entry: 'generate-upload-url.ts', verifyJwt: true },
  { id: 'system.completeUpload', entry: 'complete-upload.ts', verifyJwt: true },
  { id: 'images.urls', entry: 'image-urls.ts', verifyJwt: false },
];

export async function functionDeploys(dir = DIR) {
  const rules = await readFile(path.join(dir, RULES), 'utf8');
  return Promise.all(FUNCTIONS.map(async ({ id, entry, verifyJwt }) => ({
    id,
    name: id,
    verifyJwt,
    files: [
      { path: 'index.ts', content: await readFile(path.join(dir, entry), 'utf8') },
      { path: RULES, content: rules },
    ],
  })));
}
