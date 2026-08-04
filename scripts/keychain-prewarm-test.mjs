import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-keychain-prewarm-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const require = createRequire(import.meta.url);
const keychain = require('../src/lib/keychain-cjs.cjs');

test('keychain prewarm is one process-wide promise before and after completion', async () => {
  try {
    const first = keychain.prewarmSecrets();
    const concurrent = keychain.prewarmSecrets();
    assert.equal(concurrent, first);
    await first;
    assert.equal(keychain.prewarmSecrets(), first);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
