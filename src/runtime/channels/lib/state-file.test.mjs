import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonStateFile } from './state-file.mjs';

test('a NUL-filled state file is kept aside by ensure and never blocks update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-state-file-'));
  const file = join(dir, 'status.json');
  try {
    writeFileSync(file, Buffer.alloc(40));
    const state = new JsonStateFile(file, {});
    state.ensure();
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
    assert.ok(readdirSync(dir).some((name) => name.startsWith('status.json.corrupt-')));

    writeFileSync(file, Buffer.alloc(40));
    state.update((draft) => {
      draft.channelId = 'c1';
    });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { channelId: 'c1' });
    state.update((draft) => {
      draft.channelId = '';
    });
    assert.deepEqual(state.read(), { channelId: '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
