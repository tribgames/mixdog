import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('voice manifest contains no language-specific model', async () => {
  const manifest = JSON.parse(await readFile(new URL('./data/voice-runtime-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.models), ['standard']);
  assert.equal(manifest.models.standard.id, 'large-v3-turbo-q8_0');
});
