import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RELEASED_FILE, createReleasedStore } from './released-store.mjs';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-released-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, RELEASED_FILE) };
}

/** Collect what the process writes to stderr while `t` runs. */
function captureStderr(t) {
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

test('every released session stays released, however many there are', async (t) => {
  const { file } = tempFile(t);
  const ids = Array.from({ length: 501 }, (_, index) => `sess_${index}`);
  const store = createReleasedStore(file);
  store.mark(ids);
  assert.ok(ids.every((id) => store.isReleased(id)), 'released before the write lands');
  await store.flush();
  assert.ok(ids.every((id) => store.isReleased(id)), 'released once persisted');
  const reopened = createReleasedStore(file);
  assert.ok(ids.every((id) => reopened.isReleased(id)), 'released for a store reading the file');
});

test('a missing file is an empty store', (t) => {
  const { file } = tempFile(t);
  assert.equal(createReleasedStore(file).isReleased('sess_1'), false);
});

test('a read error other than a missing file is thrown, not read as empty', (t) => {
  const { file } = tempFile(t);
  mkdirSync(file); // stat succeeds, reading it as a file fails with EISDIR
  assert.throws(() => createReleasedStore(file).isReleased('sess_1'), { code: 'EISDIR' });
});

test('a malformed file is reported, kept on disk, and moved aside by the next save', async (t) => {
  const { dir, file } = tempFile(t);
  const malformed = '{"released": {"sess_1": ';
  writeFileSync(file, malformed);
  const written = captureStderr(t);
  const store = createReleasedStore(file);
  assert.equal(store.isReleased('sess_1'), false);
  assert.equal(readFileSync(file, 'utf8'), malformed, 'reading does not touch the file');
  assert.ok(
    written.some((line) => line.includes(file) && line.includes('malformed')),
    'the malformed file is reported'
  );

  store.mark(['sess_2']);
  await store.flush();
  const kept = readdirSync(dir).filter((name) => name.startsWith(`${RELEASED_FILE}.corrupt-`));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), malformed, 'the malformed bytes are preserved');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).released), ['sess_2']);
});
