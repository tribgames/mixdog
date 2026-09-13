import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRemoteIntent } from './channel-binding.mjs';

for (const code of ['EACCES', 'EBUSY', 'EIO']) {
  test(`a binding read failure (${code}) preserves the saved intent and original error`, (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'mixdog-channel-binding-'));
    const path = join(dir, 'intent.json');
    const value = JSON.stringify({
      version: 1,
      sessionId: 'sess_saved',
      transcriptPath: join(dir, 'sess_saved.jsonl'),
      cwd: dir,
    });
    fs.writeFileSync(path, value);
    const originalRead = fs.readFileSync;
    const failure = Object.assign(new Error(`binding read failed: ${code}`), { code });
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    t.mock.method(fs, 'readFileSync', (target, ...args) => {
      if (target === path) throw failure;
      return originalRead(target, ...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => readRemoteIntent(path), (error) => error === failure);
    assert.equal(originalRead(path, 'utf8'), value);
  });
}
