import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRemoteIntent } from './channel-binding.mjs';

test('a valid saved intent keeps its session, transcript and restore metadata', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mixdog-channel-binding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'intent.json');
  const intent = {
    version: 1,
    sessionId: 'sess_saved',
    transcriptPath: join(dir, 'sess_saved.jsonl'),
    cwd: dir,
    updatedAt: 123,
  };
  const raw = JSON.stringify(intent);
  fs.writeFileSync(path, raw);
  assert.deepEqual(readRemoteIntent(path), intent);
  assert.equal(fs.readFileSync(path, 'utf8'), raw);
});

test('an absent intent leaves the channel unpinned without creating a file', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mixdog-channel-binding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'missing.json');
  assert.equal(readRemoteIntent(), null);
  assert.equal(readRemoteIntent(path), null);
  assert.equal(fs.existsSync(path), false);
});

for (const [name, raw] of [
  ['invalid JSON', '{'],
  ['non-object content', 'null'],
  ['missing transcript', JSON.stringify({ sessionId: 'sess_saved' })],
  ['invalid session id', JSON.stringify({ sessionId: '../other', transcriptPath: 'other.jsonl' })],
  ['mismatched transcript', JSON.stringify({ sessionId: 'sess_saved', transcriptPath: 'sess_other.jsonl' })],
]) {
  test(`an intent with ${name} cannot claim a session and is removed`, (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'mixdog-channel-binding-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'intent.json');
    fs.writeFileSync(path, raw);
    assert.equal(readRemoteIntent(path), null);
    assert.equal(fs.existsSync(path), false);
  });
}

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
    assert.throws(
      () => readRemoteIntent(path),
      (error) => error === failure
    );
    assert.equal(originalRead(path, 'utf8'), value);
  });
}
