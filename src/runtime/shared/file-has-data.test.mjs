import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exactLocalProviderFile } from '../local-provider/catalog.mjs';
import { fileHasData, fileHasDataAsync } from './file-has-data.mjs';

test('fileHasDataAsync gives the same verdict as fileHasData', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-file-has-data-async-'));
  try {
    const file = join(dir, 'engine.bin');
    for (const content of [null, '', Buffer.alloc(10_000), Buffer.from('MZ\x90'), Buffer.from('x'.repeat(9000))]) {
      if (content !== null) writeFileSync(file, content);
      assert.equal(await fileHasDataAsync(file), fileHasData(file));
    }
    assert.equal(await fileHasDataAsync(join(dir, 'missing')), false);
    assert.equal(await fileHasDataAsync(join(file, 'child')), false, 'ENOTDIR counts as absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileHasData never throws: only ENOENT and ENOTDIR are absent, any other failure counts as present', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-file-has-data-code-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'engine.bin');
  writeFileSync(file, 'x');
  const fail = (code) => {
    const error = Object.assign(new Error(code), { code });
    const openSync = fs.openSync;
    const open = fsPromises.open;
    fs.openSync = () => {
      throw error;
    };
    fsPromises.open = async () => {
      throw error;
    };
    syncBuiltinESMExports();
    return () => {
      fs.openSync = openSync;
      fsPromises.open = open;
      syncBuiltinESMExports();
    };
  };
  for (const [code, present] of [
    ['EIO', true],
    ['EACCES', true],
    ['EBUSY', true],
    ['EISDIR', true],
    ['ENOENT', false],
    ['ENOTDIR', false],
  ]) {
    const restore = fail(code);
    try {
      assert.equal(fileHasData(file), present, `sync ${code}`);
      assert.equal(await fileHasDataAsync(file), present, `async ${code}`);
    } finally {
      restore();
    }
  }
  // Not an errno failure at all (an invalid path argument): still present.
  assert.equal(fileHasData(`${dir}\0x`), true);
  assert.equal(await fileHasDataAsync(`${dir}\0x`), true);
});

test('fileHasData is false for absent, empty and NUL-filled files only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-file-has-data-'));
  try {
    const file = join(dir, 'weights.bin');
    assert.equal(fileHasData(file), false);
    writeFileSync(file, '');
    assert.equal(fileHasData(file), false);
    writeFileSync(file, Buffer.alloc(10_000));
    assert.equal(fileHasData(file), false);
    writeFileSync(file, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(10_000)]));
    assert.equal(fileHasData(file), true);
    assert.equal(exactLocalProviderFile(file, 10_004), true);
    writeFileSync(file, Buffer.alloc(10_004));
    assert.equal(
      exactLocalProviderFile(file, 10_004),
      false,
      'a NUL-filled download of the right size is not installed'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
