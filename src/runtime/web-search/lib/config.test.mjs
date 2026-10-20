import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readJson } from './config.mjs';

test('a damaged usage/cache file reads as the fallback once and is kept aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-web-config-'));
  const file = join(dir, 'usage.local.json');
  try {
    writeFileSync(file, Buffer.alloc(32));
    assert.deepEqual(readJson(file, { entries: {} }), { entries: {} });
    assert.ok(readdirSync(dir).some((name) => name.startsWith('usage.local.json.corrupt-')));
    writeFileSync(file, '{"a":1}');
    assert.deepEqual(readJson(file, null), { a: 1 });
    assert.equal(readJson(join(dir, 'absent.json'), 7), 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
