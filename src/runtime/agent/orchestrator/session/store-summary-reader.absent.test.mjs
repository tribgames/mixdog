import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

const root = makeTempDirSync('session-absent');
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const { sessionPath } = await import('./store/session-paths.mjs');
const { storedSessionAbsent, storedSessionExists } = await import('./store-summary-reader.mjs');

test('only a record that is not there is absent: one that cannot be read is not', () => {
  mkdirSync(dirname(sessionPath('sess_broken')), { recursive: true });
  writeFileSync(sessionPath('sess_broken'), '{"id": "sess_broken", "messages": [');
  assert.equal(storedSessionExists('sess_broken'), false, 'the strict check does not vouch for it');
  assert.equal(storedSessionAbsent('sess_broken'), false);
  assert.equal(storedSessionAbsent('sess_never'), true);
  rmSync(sessionPath('sess_broken'));
  assert.equal(storedSessionAbsent('sess_broken'), true);
});
