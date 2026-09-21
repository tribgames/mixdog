import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readJsonSafe } from './json-file.mjs';
import { readJsonOrNull } from './native-asset.mjs';

test('native-asset JSON reads use the shared safe parser', (t) => {
  assert.equal(readJsonOrNull, readJsonSafe);
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-json-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, 'missing.json');
  const malformed = join(dir, 'malformed.json');
  const valid = join(dir, 'valid.json');
  writeFileSync(malformed, '{');
  writeFileSync(valid, '{"ok":true}\n');
  assert.equal(readJsonSafe(missing), null);
  assert.equal(readJsonSafe(malformed), null);
  assert.deepEqual(readJsonSafe(valid), { ok: true });
});
