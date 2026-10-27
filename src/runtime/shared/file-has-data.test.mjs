import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
