import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exactLocalProviderFile } from '../local-provider/catalog.mjs';
import { fileHasData } from './file-has-data.mjs';

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
