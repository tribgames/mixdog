// The representative bot's display name: a missing, empty or malformed
// agent.json is the unrenamed default, and so is any read failure.
import assert from 'node:assert/strict';
import fs, { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { makeTempDirSync, removeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

const root = makeTempDirSync('mixy-name');
const saved = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { DEFAULT_MIXY_NAME, mixyDisplayName } = await import('./mixy-name.mjs');
const { mixyIdentityDir } = await import('../../../shared/agent-store.mjs');
const manifest = join(mixyIdentityDir(process.env.MIXDOG_DATA_DIR), 'agent.json');

after(() => {
  if (saved === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = saved;
  removeTempDirSync(root);
});

test('no agent.json, an empty one and a malformed one read as the default name', () => {
  assert.equal(mixyDisplayName(), DEFAULT_MIXY_NAME);
  mkdirSync(join(manifest, '..'), { recursive: true });
  for (const text of ['', '{ not json', '{ "name": "  " }', '[]']) {
    writeFileSync(manifest, text);
    assert.equal(mixyDisplayName(), DEFAULT_MIXY_NAME, JSON.stringify(text));
  }
  writeFileSync(manifest, '{ "name": " Momo " }');
  assert.equal(mixyDisplayName(), 'Momo');
});

test('any read failure reads as the default name, so prompt composition never aborts', (t) => {
  rmSync(manifest, { force: true });
  mkdirSync(manifest);
  assert.equal(mixyDisplayName(), DEFAULT_MIXY_NAME, 'EISDIR');
  const original = fs.readFileSync;
  fs.readFileSync = (path, ...rest) => {
    if (String(path) === manifest) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  assert.equal(mixyDisplayName(), DEFAULT_MIXY_NAME, 'EACCES');
});
