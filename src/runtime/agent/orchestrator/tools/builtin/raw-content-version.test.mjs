import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-raw-content-version-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const {
  cacheGet, cacheSet, invalidateBuiltinResultCache,
  rawContentCacheGet, rawContentCacheSet, runRawContentInFlight,
} = await import('./cache-layers.mjs');
const { detectReadEncodingFromBuffer } = await import('./snapshot-helpers.mjs');
const { bufferedReadResult } = await import('./read-single-render.mjs');
const { executeBuiltinTool } = await import('../builtin.mjs');
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
test.afterEach(() => invalidateBuiltinResultCache());

const body = Buffer.from('BEFORE\n');
const version = () => ({ mtimeMs: 1000, ctimeMs: 2000, size: body.length, ino: 3, dev: 4 });
const file = () => join(root, `${randomUUID()}.txt`);
const changes = [
  ['mtimeMs', 0.5], ['ctimeMs', 0.5], ['mtimeMs', 1], ['ctimeMs', 1],
  ['size', 1], ['ino', 1], ['dev', 1],
];

test('an identical file version reuses the buffer and owns its metadata snapshot', () => {
  const path = file();
  const st = version();
  rawContentCacheSet(path, st, body);
  assert.equal(rawContentCacheGet(path, { ...st }), body);
  st.ino += 1;
  assert.equal(rawContentCacheGet(path, version()), body, 'later caller mutation cannot relabel cached bytes');
  assert.equal(rawContentCacheGet(path, st), null);
});

for (const [field, delta] of changes) {
  test(`raw cache rejects a ${field} change of ${delta}`, () => {
    const path = file();
    const st = version();
    rawContentCacheSet(path, st, body);
    assert.equal(rawContentCacheGet(path, { ...st, [field]: st[field] + delta }), null);
    assert.equal(rawContentCacheGet(path, st), null, 'a mismatch evicts the old entry');
  });
}

test('incomplete and non-finite version evidence cannot authorize cache insertion or reuse', () => {
  for (const field of ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev']) {
    for (const value of [undefined, null, NaN, Infinity]) {
      const path = file();
      const bad = { ...version(), [field]: value };
      rawContentCacheSet(path, bad, body);
      assert.equal(rawContentCacheGet(path, bad), null, `${field}=${value}`);
      rawContentCacheSet(path, version(), body);
      assert.equal(rawContentCacheGet(path, bad), null, `${field}=${value} lookup`);
    }
  }
});

test('a full raw body must match its recorded byte size; empty buffers still cache', () => {
  const path = file();
  rawContentCacheSet(path, version(), body.subarray(1));
  assert.equal(rawContentCacheGet(path, version()), null);
  const empty = Buffer.alloc(0);
  rawContentCacheSet(path, { ...version(), size: 0 }, empty);
  assert.equal(rawContentCacheGet(path, { ...version(), size: 0 }), empty);
});

test('strict raw entries retain TTL, canonical paths and targeted invalidation', () => {
  const path = file();
  const sibling = file();
  const alias = process.platform === 'win32' ? path.toUpperCase() : path;
  rawContentCacheSet(path, version(), body, 100);
  assert.equal(rawContentCacheGet(alias, version(), 30_100), body);
  assert.equal(rawContentCacheGet(path, version(), 30_101), null);
  rawContentCacheSet(path, version(), body);
  rawContentCacheSet(sibling, version(), body);
  invalidateBuiltinResultCache([alias]);
  assert.equal(rawContentCacheGet(path, version()), null);
  assert.equal(rawContentCacheGet(sibling, version()), body);
});

test('in-flight reads share only the same observed version, even before watcher invalidation', async () => {
  const path = file();
  const oldDone = Promise.withResolvers();
  const newDone = Promise.withResolvers();
  const oldStarted = Promise.withResolvers();
  let loads = 0;
  const old = runRawContentInFlight(path, () => {
    loads += 1;
    oldStarted.resolve();
    return oldDone.promise;
  }, version());
  await oldStarted.promise;
  const same = runRawContentInFlight(path, () => { throw new Error('must share'); }, version());
  const nextVersion = { ...version(), ctimeMs: version().ctimeMs + 0.5 };
  const fresh = runRawContentInFlight(path, () => { loads += 1; return newDone.promise; }, nextVersion);
  try {
    oldDone.resolve('old');
    assert.deepEqual(await Promise.all([old, same]), ['old', 'old']);
    // The old completion cannot remove the newer pending read.
    const joined = runRawContentInFlight(path, () => { throw new Error('must share new'); }, nextVersion);
    newDone.resolve('new');
    assert.deepEqual(await Promise.all([fresh, joined]), ['new', 'new']);
    assert.equal(loads, 2);
  } finally {
    oldDone.resolve('old');
    newDone.resolve('new');
    await Promise.allSettled([old, same, fresh]);
  }
});

function renderFixture(buffer = body) {
  const path = file();
  writeFileSync(path, buffer);
  const ctx = {
    fullPath: path, filePath: path, st: statSync(path), cacheKey: randomUUID(), readStateScope: {},
    offset: 0, limit: Infinity, hasRangeArgs: false, wantFull: true,
    readMaxOutputBytes: 65536, readOffsetBase: 0, widenNote: '',
  };
  const snapshots = [];
  const helpers = {
    renderReadLine: (_n, line) => line, normalizeOutputPath: (value) => value,
    _hashText: (text) => createHash('sha256').update(text).digest('hex'),
    _rangeHashesForReadRanges: () => { throw new Error('fixture is a full read'); },
    _cacheSet: cacheSet, _rawContentCacheSet: rawContentCacheSet,
    _recordReadSnapshot: (...args) => snapshots.push(args),
  };
  return { ctx, helpers, snapshots };
}

for (const field of ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev']) {
  test(`a post-read ${field} mismatch never promotes bytes to the newer version`, async () => {
    const { ctx, helpers, snapshots } = renderFixture(Buffer.from('AFTER_\n'));
    const current = ctx.st;
    // Deterministic pre/post versions: do not depend on host clock resolution.
    ctx.st = { ...current, [field]: current[field] - (field.endsWith('Ms') ? 0.5 : 1) };
    const out = await bufferedReadResult(ctx, { prefetched: { buf: body, fromCache: false }, readEnc: { encoding: 'utf8', bomLen: 0 } }, helpers);
    assert.equal(out, 'BEFORE', 'the active caller keeps its observation without an implicit replay');
    assert.equal(rawContentCacheGet(ctx.fullPath, current), null);
    assert.equal(cacheGet(ctx.cacheKey), null, 'rendered reuse cannot certify the unstable body either');
    assert.equal(snapshots.length, 0, 'no edit-authorizing snapshot is stamped with unrelated metadata');
  });
}

test('a failed post-read stat is uncertainty, not proof of stability', async () => {
  const { ctx, helpers, snapshots } = renderFixture();
  rmSync(ctx.fullPath);
  assert.equal(await bufferedReadResult(ctx, { prefetched: { buf: body, fromCache: false }, readEnc: { encoding: 'utf8', bomLen: 0 } }, helpers), 'BEFORE');
  assert.equal(rawContentCacheGet(ctx.fullPath, ctx.st), null);
  assert.equal(cacheGet(ctx.cacheKey), null);
  assert.equal(snapshots.length, 0);
});

test('stable fresh and cached UTF-8/UTF-16 bodies preserve decoding and snapshot recording', async () => {
  for (const buffer of [
    Buffer.from('한글\n'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('한글\n', 'utf16le')]),
  ]) {
    const enc = detectReadEncodingFromBuffer(buffer);
    const { ctx, helpers, snapshots } = renderFixture(buffer);
    const first = await bufferedReadResult(ctx, { prefetched: { buf: buffer, fromCache: false }, readEnc: enc }, helpers);
    assert.equal(first, '한글');
    const cached = rawContentCacheGet(ctx.fullPath, statSync(ctx.fullPath));
    assert.equal(cached, buffer);
    assert.equal(await bufferedReadResult(ctx, { prefetched: { buf: cached, fromCache: true }, readEnc: enc }, helpers), first);
    assert.equal(cacheGet(ctx.cacheKey), first);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0][1], ctx.st);
  }
});

for (const field of ['mtimeMs', 'ctimeMs', 'ino', 'dev']) {
  test(`public read cannot relabel a raw body from a different ${field}`, async () => {
    const path = file();
    writeFileSync(path, 'AFTER_\n');
    const current = statSync(path);
    const previous = { ...current, [field]: current[field] - (field.endsWith('Ms') ? 0.5 : 1) };
    // Seed the previously observed version; the rendered cache is cold.
    rawContentCacheSet(path, previous, body);
    const out = String(await executeBuiltinTool('read', { file_path: path }, root, { sessionId: randomUUID() }));
    assert.match(out, /AFTER_/);
    assert.doesNotMatch(out, /BEFORE/);
    assert.deepEqual(rawContentCacheGet(path, statSync(path)), readFileSync(path));
  });
}
