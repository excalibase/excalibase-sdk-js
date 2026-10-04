import assert from 'node:assert/strict';
import { test } from 'node:test';
import { functionDeploys } from './functions.mjs';

test('the store deploys the SDK upload functions and the image link query', async () => {
  const deploys = await functionDeploys();
  const byId = Object.fromEntries(deploys.map((d) => [d.id, d]));
  assert.deepEqual(Object.keys(byId).sort(), ['images.urls', 'system.completeUpload', 'system.generateUploadUrl']);
  // Uploads need a verified token (the rule reads its role); guests read links.
  assert.equal(byId['system.generateUploadUrl'].verifyJwt, true);
  assert.equal(byId['system.completeUpload'].verifyJwt, true);
  assert.equal(byId['images.urls'].verifyJwt, false);
});

test('every function carries its entry as index.ts and the shared storage rules', async () => {
  for (const deploy of await functionDeploys()) {
    const paths = deploy.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['index.ts', 'storage-rules.ts'], deploy.id);
    const entry = deploy.files.find((f) => f.path === 'index.ts').content;
    assert.match(entry, /from "\.\/storage-rules\.ts"/, deploy.id);
    assert.doesNotMatch(entry, /^import .* from "\.\.\//m, deploy.id);
  }
});

test('every function refuses a caller with FunctionError, so the caller gets 4xx and not 500', async () => {
  for (const deploy of await functionDeploys()) {
    const entry = deploy.files.find((f) => f.path === 'index.ts').content;
    assert.match(entry, /import \{[^}]*\bFunctionError\b[^}]*\} from "npm:@excalibase\/server@0\.13\.0"/, deploy.id);
    assert.match(entry, /throw new FunctionError\(refusal\.status, refusal\.message\)/, deploy.id);
    assert.doesNotMatch(entry, /throw new Error\(/, deploy.id);
  }
  const [first] = await functionDeploys();
  const rules = first.files.find((f) => f.path === 'storage-rules.ts').content;
  assert.doesNotMatch(rules, /throw /, 'storage rules return refusals; the functions throw them');
});
