import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { findCachedBinary, installVerifiedBinary } from './native-asset.mjs';

const GOOD = Buffer.from('good binary bytes');
const EVIL = Buffer.from('evil binary bytes');
const SHA = createHash('sha256').update(GOOD).digest('hex');
const MTIME = 1_700_000_000;

function fixture(t) {
  const dir = makeTempDirSync('native-asset-digest');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const file = join(dir, 'tool');
  writeFileSync(file, GOOD);
  utimesSync(file, MTIME, MTIME);
  // Same length, same mtime: size and timestamp cannot tell these bytes apart.
  const tamper = () => {
    writeFileSync(file, EVIL);
    utimesSync(file, MTIME, MTIME);
  };
  return { dir, file, tamper };
}

test('findCachedBinary rejects different bytes of equal size and preserved mtime', (t) => {
  const { dir, file, tamper } = fixture(t);
  const lookup = () => findCachedBinary({ dir, fileName: 'tool', sha256: SHA });
  assert.equal(lookup(), file);
  tamper();
  assert.equal(EVIL.length, GOOD.length);
  assert.equal(lookup(), null);
});

test('installVerifiedBinary replaces different bytes of equal size and preserved mtime', async (t) => {
  const { dir, file, tamper } = fixture(t);
  const asset = { url: 'test://tool', sha256: SHA };
  const download = async (_url, destPath) => writeFileSync(destPath, GOOD);
  const install = () =>
    installVerifiedBinary({ dir, fileName: 'tool', asset, download, label: '[test]', pkey: 'p', gcPrefix: 'tool' });
  assert.equal(await install(), file);
  tamper();
  assert.equal(await install(), file);
  assert.deepEqual(readFileSync(file), GOOD);
});
