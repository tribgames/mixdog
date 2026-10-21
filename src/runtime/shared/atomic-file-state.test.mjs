import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, mock, test } from 'node:test';

// The recovery lock is the only seam where another process can act between
// this reader's first read and its recovery; the wrapper lets a test do that.
const fileLockUrl = new URL('./file-lock.mjs', import.meta.url).href;
const fileLock = await import(fileLockUrl);
let whileWaitingForLock = null;
const runWhileWaiting = () => {
  const action = whileWaitingForLock;
  whileWaitingForLock = null;
  action?.();
};
mock.module(fileLockUrl, {
  namedExports: {
    ...fileLock,
    withFileLockSync(lockPath, fn, opts) {
      runWhileWaiting();
      return fileLock.withFileLockSync(lockPath, fn, opts);
    },
    withFileLock(lockPath, fn, opts) {
      runWhileWaiting();
      return fileLock.withFileLock(lockPath, fn, opts);
    },
  },
});
const {
  readJsonState,
  quarantinePath,
  readJsonStateSync,
  unsupportedState,
  updateJsonAtomic,
  writeFileAtomicSync,
  writeJsonAtomicSync,
} = await import('./atomic-file.mjs');

const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-atomic-state-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;
const freshFile = () => {
  const dir = join(root, String(seq++));
  fs.mkdirSync(dir);
  return join(dir, 'state.json');
};
const asideFiles = (path) => fs.readdirSync(join(path, '..')).filter((name) => name.startsWith('state.json.corrupt-'));
const fallback = { empty: true };

test('a NUL-filled file reads as the fallback and is kept aside', () => {
  const path = freshFile();
  fs.writeFileSync(path, Buffer.alloc(512));
  assert.deepEqual(readJsonStateSync(path, { fallback }), fallback);
  assert.equal(fs.existsSync(path), false);
  const [aside] = asideFiles(path);
  assert.deepEqual(fs.readFileSync(join(path, '..', aside)), Buffer.alloc(512));
});

test('truncated JSON and a rejected shape are damage too', () => {
  const truncated = freshFile();
  fs.writeFileSync(truncated, '{"version":1,"items":[');
  assert.deepEqual(readJsonStateSync(truncated, { fallback }), fallback);
  assert.equal(fs.readFileSync(join(truncated, '..', asideFiles(truncated)[0]), 'utf8'), '{"version":1,"items":[');

  const rejected = freshFile();
  fs.writeFileSync(rejected, '[]');
  const validate = (value) => {
    if (!value || Array.isArray(value)) throw new Error('not a state object');
    return value;
  };
  assert.deepEqual(readJsonStateSync(rejected, { validate, fallback }), fallback);
  assert.equal(asideFiles(rejected).length, 1);
});

test('a newer build format is left in place, untouched, and reads as the fallback', () => {
  const path = freshFile();
  fs.writeFileSync(path, '{"version":9,"items":[1]}');
  const validate = (value) => {
    if (value.version > 1) throw unsupportedState('newer');
    return value;
  };
  assert.deepEqual(readJsonStateSync(path, { validate, fallback }), fallback);
  assert.equal(fs.readFileSync(path, 'utf8'), '{"version":9,"items":[1]}');
  assert.equal(asideFiles(path).length, 0);
});

test('keepWithoutBackup leaves a damaged file in place unless a good copy exists', () => {
  const kept = freshFile();
  fs.writeFileSync(kept, Buffer.alloc(32));
  assert.deepEqual(readJsonStateSync(kept, { fallback, keepWithoutBackup: true }), fallback);
  assert.deepEqual(fs.readFileSync(kept), Buffer.alloc(32));
  assert.equal(asideFiles(kept).length, 0);

  const restored = freshFile();
  fs.writeFileSync(restored, Buffer.alloc(32));
  fs.writeFileSync(`${restored}.bak`, '{"good":true}');
  assert.deepEqual(readJsonStateSync(restored, { fallback, keepWithoutBackup: true }), { good: true });
  assert.equal(asideFiles(restored).length, 1);
});

test('restoreBackup: false never brings back an older copy', () => {
  const path = freshFile();
  fs.writeFileSync(`${path}.bak`, '{"stale":true}');
  fs.writeFileSync(path, Buffer.alloc(16));
  assert.deepEqual(readJsonStateSync(path, { fallback, restoreBackup: false }), fallback);
  assert.equal(fs.existsSync(path), false);
  assert.equal(asideFiles(path).length, 1);
});

test('a missing file is the fallback and nothing is created', () => {
  const path = freshFile();
  assert.deepEqual(readJsonStateSync(path, { fallback }), fallback);
  assert.deepEqual(fs.readdirSync(join(path, '..')), []);
});

test('the last good copy kept by backup writes is restored', () => {
  const path = freshFile();
  writeJsonAtomicSync(path, { n: 1 }, { backup: true });
  writeJsonAtomicSync(path, { n: 2 }, { backup: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${path}.bak`, 'utf8')), { n: 1 });
  fs.writeFileSync(path, Buffer.alloc(64));
  assert.deepEqual(readJsonStateSync(path, { fallback }), { n: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), { n: 1 });
  assert.equal(asideFiles(path).length, 1);
});

test('a damaged version never becomes the backup', () => {
  const path = freshFile();
  writeJsonAtomicSync(path, { n: 1 }, { backup: true });
  writeJsonAtomicSync(path, { n: 2 }, { backup: true });
  fs.writeFileSync(path, '{"n":');
  writeJsonAtomicSync(path, { n: 3 }, { backup: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${path}.bak`, 'utf8')), { n: 1 });
});

test('a file repaired while this reader waits for the lock is kept and read', () => {
  const path = freshFile();
  fs.writeFileSync(path, Buffer.alloc(256));
  whileWaitingForLock = () => fs.writeFileSync(path, JSON.stringify({ repaired: true }));
  assert.deepEqual(readJsonStateSync(path, { fallback }), { repaired: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), { repaired: true });
  assert.equal(asideFiles(path).length, 0);
});

test('async reads recover the same way', async () => {
  const path = freshFile();
  fs.writeFileSync(path, Buffer.alloc(128));
  assert.deepEqual(await readJsonState(path, { fallback }), fallback);
  assert.equal(asideFiles(path).length, 1);
});

test('a read-modify-write keeps damaged bytes aside before replacing them', async () => {
  const path = freshFile();
  fs.writeFileSync(path, '{"hand":"edited",');
  const next = await updateJsonAtomic(path, (current) => ({ ...(current || {}), written: true }));
  assert.deepEqual(next, { written: true });
  assert.equal(fs.readFileSync(join(path, '..', asideFiles(path)[0]), 'utf8'), '{"hand":"edited",');
});

test('two quarantines of one file in the same millisecond keep both damaged copies', async (t) => {
  const frozen = Date.now();
  const clock = t.mock.method(Date, 'now', () => frozen);
  const syncRead = freshFile();
  fs.writeFileSync(syncRead, 'first damage');
  readJsonStateSync(syncRead, { fallback });
  fs.writeFileSync(syncRead, 'second damage');
  readJsonStateSync(syncRead, { fallback });

  const asyncRead = freshFile();
  fs.writeFileSync(asyncRead, 'first damage');
  await readJsonState(asyncRead, { fallback });
  fs.writeFileSync(asyncRead, 'second damage');
  await readJsonState(asyncRead, { fallback });
  clock.mock.restore();

  for (const path of [syncRead, asyncRead]) {
    const kept = asideFiles(path).map((name) => fs.readFileSync(join(path, '..', name), 'utf8'));
    assert.deepEqual(kept.sort(), ['first damage', 'second damage']);
  }
});

test('a quarantine name is no longer than the original `.corrupt-<ms>` shape', (t) => {
  // The lock's staging file (`<name>.lock.<pid>.<hex>.tmp`) caps how long a
  // recovered basename can be, so the name is checked where it is built: 225
  // characters + `.corrupt-<13 digits>` stays within 255 even on a collision.
  const dir = join(root, `long-${seq++}`);
  fs.mkdirSync(dir);
  const path = join(dir, `${'n'.repeat(220)}.json`);
  const frozen = Date.now();
  t.mock.method(Date, 'now', () => frozen);
  const first = quarantinePath(path);
  assert.equal(first, `${path}.corrupt-${frozen}`);
  fs.writeFileSync(first, 'kept');
  const second = quarantinePath(path);
  assert.equal(second, `${path}.corrupt-${frozen + 1}`);
  assert.ok(basename(second).length <= 255, `${basename(second).length} characters`);
});

test('a read-only file mode is written and flushed through its creating handle', (t) => {
  const path = freshFile();
  t.after(() => fs.chmodSync(path, 0o644));
  writeFileAtomicSync(path, 'kept', { mode: 0o444 });
  assert.equal(fs.readFileSync(path, 'utf8'), 'kept');
});
