import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-raw-publication-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { rawContentCacheGet, rawContentCacheSet, invalidateBuiltinResultCache } = await import('./cache-layers.mjs');
const { readTextForSnapshotCheck } = await import('./read-snapshot-runtime.mjs');
const { convertV4ASectionsToUnifiedPatch } = await import('../patch/v4a-convert.mjs');
const { parseV4APatch } = await import('../patch/parsing.mjs');
const { fileVersion } = await import('./file-version.mjs');
const { publishRawContentAfterRead } = await import('./raw-content-publication.mjs');
process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
test.afterEach(() => invalidateBuiltinResultCache());

let sequence = 0;
function fixture(bytes = Buffer.from('BEFORE\n')) {
  const path = join(root, `file-${sequence++}.txt`);
  fs.writeFileSync(path, bytes);
  return { path, bytes, st: fs.statSync(path) };
}

function patchFor(path, from = 'BEFORE') {
  return parseV4APatch(`*** Begin Patch\n*** Update File: ${basename(path)}\n@@\n-${from}\n+EDITED\n*** End Patch\n`);
}
const routes = [
  { name: 'snapshot', stat: 'statSync', run: (path) => readTextForSnapshotCheck(path),
    observed: (out) => assert.equal(out, 'BEFORE\n') },
  { name: 'V4A', stat: 'lstatSync', run: (path) => convertV4ASectionsToUnifiedPatch(patchFor(path), root),
    observed: (out) => { assert.match(out, /-BEFORE\n\+EDITED/); } },
];

// Intercept only this temporary target's leaf IO; public readers, converter,
// caches, parsing/encoding and the rest of the filesystem run unchanged.
function intercept(t, path, statName, { post = (st) => st, read = (buf) => buf, pre = (st) => st } = {}) {
  const originalRead = fs.readFileSync;
  const originalStat = fs[statName];
  const calls = { reads: 0, stats: 0, posts: 0 };
  const readMock = t.mock.method(fs, 'readFileSync', (target, ...args) => {
    const buf = originalRead(target, ...args);
    if (target !== path) return buf;
    calls.reads++;
    return read(buf);
  });
  const statMock = t.mock.method(fs, statName, (target, ...args) => {
    const st = originalStat(target, ...args);
    if (target !== path) return st;
    calls.stats++;
    if (calls.reads) { calls.posts++; return post(st); }
    return pre(st);
  });
  syncBuiltinESMExports();
  const restore = () => {
    readMock.mock.restore(); statMock.mock.restore(); syncBuiltinESMExports();
  };
  t.after(restore);
  return { calls, restore };
}
function changed(st, field) {
  const value = field === 'ino' || field === 'dev' ? (st[field] === 0 ? 1 : 0)
    : st[field] + (field.endsWith('Ms') ? 0.5 : 1);
  assert.notEqual(value, st[field], `${field}: fixture must differ even on NTFS`);
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { [field]: value });
}

for (const route of routes) {
  for (const field of ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev']) {
    test(`${route.name}: a post-read ${field} mismatch cannot publish either version`, async (t) => {
      const { path, st } = fixture();
      let after;
      const io = intercept(t, path, route.stat, { post: (live) => (after = changed(live, field)) });
      route.observed(await route.run(path));
      assert.equal(io.calls.posts, 1, 'fresh IO must be followed by a stat, not cache insertion alone');
      assert.equal(rawContentCacheGet(path, st), null);
      assert.equal(rawContentCacheGet(path, after), null, 'never relabel old bytes with the later stat');
      io.restore();
      route.observed(await route.run(path));
      assert.ok(rawContentCacheGet(path, fs.statSync(path)), 'the next stable invocation can publish');
    });
  }

  test(`${route.name}: failed post-read stat preserves the observation but publishes nothing`, async (t) => {
    const { path, st } = fixture();
    const io = intercept(t, path, route.stat, { post() { throw Object.assign(new Error('post-read failure'), { code: 'EIO' }); } });
    route.observed(await route.run(path));
    assert.equal(io.calls.posts, 1);
    assert.equal(rawContentCacheGet(path, st), null);
  });

  test(`${route.name}: incomplete post-read evidence cannot publish`, async (t) => {
    const { path, st } = fixture();
    intercept(t, path, route.stat, { post(live) { live.ino = undefined; return live; } });
    route.observed(await route.run(path));
    assert.equal(rawContentCacheGet(path, st), null);
  });

  test(`${route.name}: stable reads publish and a raw-cache hit adds no read or post-stat`, async (t) => {
    const { path, bytes, st } = fixture();
    const io = intercept(t, path, route.stat);
    route.observed(await route.run(path));
    assert.equal(io.calls.reads, 1);
    assert.equal(io.calls.posts, 1);
    assert.deepEqual(rawContentCacheGet(path, st), bytes);
    io.restore();
    const hit = intercept(t, path, route.stat, { read() { throw new Error('a hit must not reread'); } });
    route.observed(await route.run(path));
    assert.equal(hit.calls.reads, 0);
    assert.equal(hit.calls.stats, 1);
    assert.equal(hit.calls.posts, 0);
  });

  test(`${route.name}: owns pre-read identity even if the supplied Stats object is later mutated`, async (t) => {
    const { path, st } = fixture();
    const after = changed(st, 'ino');
    intercept(t, path, route.stat, {
      pre: () => st,
      read(buf) { Object.assign(st, after); return buf; },
      post: () => after,
    });
    route.observed(await route.run(path));
    assert.equal(rawContentCacheGet(path, after), null);
  });

  test(`${route.name}: a real replacement during read cannot seed the shared cache`, async (t) => {
    const { path, st } = fixture();
    const replacement = Buffer.from('AFTER replacement has different size\n');
    const io = intercept(t, path, route.stat, { read(buf) {
      fs.writeFileSync(`${path}.next`, replacement);
      fs.renameSync(`${path}.next`, path);
      return buf;
    } });
    route.observed(await route.run(path));
    assert.equal(rawContentCacheGet(path, st), null);
    assert.equal(rawContentCacheGet(path, fs.statSync(path)), null);
    io.restore();
    assert.deepEqual(fs.readFileSync(path), replacement);
  });

  test(`${route.name}: a read failure is not swallowed as a post-stat cache miss`, async (t) => {
    const { path } = fixture();
    intercept(t, path, route.stat, { read() { throw Object.assign(new Error('read failure'), { code: 'EIO' }); } });
    await assert.rejects(async () => route.run(path), /EIO|read failure/);
  });
}

test('snapshot: caller-provided stale versions and failed pre-stat do not authorize publication', (t) => {
  const { path, st } = fixture();
  assert.equal(readTextForSnapshotCheck(path, null, changed(st, 'ino')), 'BEFORE\n');
  assert.equal(rawContentCacheGet(path, st), null);
  const io = intercept(t, path, 'statSync', { pre() { throw new Error('pre-stat failed'); } });
  assert.equal(readTextForSnapshotCheck(path), 'BEFORE\n');
  assert.equal(io.calls.reads, 1);
  assert.equal(rawContentCacheGet(path, st), null);
});

test('snapshot: invocation-local content, raw seeds and delegated reads keep their existing ownership', (t) => {
  const { path, bytes, st } = fixture();
  const io = intercept(t, path, 'statSync', { read() { throw new Error('must use invocation cache'); } });
  const scratch = { content: 'local text', rawBuf: Buffer.from('local text') };
  assert.equal(readTextForSnapshotCheck(path, scratch), 'local text');
  assert.equal(readTextForSnapshotCheck(path, { getEntry: () => ({ content: 'entry text' }), readTextSync() { throw new Error('must use entry'); } }), 'entry text');
  rawContentCacheSet(path, st, bytes);
  let seeded;
  assert.equal(readTextForSnapshotCheck(path, {
    getEntry: () => null, seedBuffer: (_path, buf) => { seeded = buf; },
    readTextSync: () => seeded.toString(),
  }), 'BEFORE\n');
  assert.equal(seeded, bytes);
  assert.equal(io.calls.reads, 0);
  invalidateBuiltinResultCache();
  assert.equal(readTextForSnapshotCheck(path, { readTextSync: () => 'delegated text' }), 'delegated text');
  assert.equal(rawContentCacheGet(path, st), null, 'delegation must not introduce a global publication');
});

test('publication: invalid evidence, partial buffers and post-stat failure leave a newer cache entry untouched', () => {
  const { path, bytes, st } = fixture();
  rawContentCacheSet(path, st, bytes);
  const before = fileVersion(st);
  const attempts = [
    [null, bytes, () => st],
    [{ ...before, dev: NaN }, bytes, () => st],
    [before, bytes.subarray(1), () => st],
    [before, bytes, () => ({ ...before, ino: Infinity })],
    [before, bytes, () => { throw new Error('uncertain'); }],
  ];
  for (const [version, buffer, readStat] of attempts) {
    publishRawContentAfterRead(path, version, buffer, readStat);
    assert.equal(rawContentCacheGet(path, st), bytes);
  }
});

test('snapshot: zero-byte files remain cacheable', () => {
  const { path, bytes, st } = fixture(Buffer.alloc(0));
  assert.equal(readTextForSnapshotCheck(path), '');
  assert.deepEqual(rawContentCacheGet(path, st), bytes);
});

for (const encoding of ['utf8', 'utf8bom', 'utf16le', 'utf16be']) {
  test(`snapshot and V4A preserve ${encoding} decoding and the exact cached bytes`, async () => {
    const text = '한글\n';
    const body = Buffer.from(text, encoding.startsWith('utf16') ? 'utf16le' : 'utf8');
    const bytes = encoding === 'utf16be' ? Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body).swap16()])
      : encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), body])
      : encoding === 'utf8bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
    for (const reader of ['snapshot', 'V4A']) {
      const { path, st } = fixture(bytes);
      if (reader === 'snapshot') assert.equal(readTextForSnapshotCheck(path), text);
      else assert.match(await convertV4ASectionsToUnifiedPatch(patchFor(path, '한글'), root), /-한글/);
      assert.deepEqual(rawContentCacheGet(path, st), bytes);
    }
  });
}

test('V4A: symlink metadata never authorizes referent-byte reuse or publication', async (t) => {
  const { path } = fixture();
  const target = basename(path);
  // Make link length and body size identical so byte-length validation alone
  // cannot paper over the link-vs-referent identity error on POSIX hosts.
  const body = Buffer.from('BEFORE\n' + ' '.repeat(Math.max(0, Buffer.byteLength(target) - 7)));
  fs.writeFileSync(path, body);
  const link = join(root, `link-${sequence++}.txt`);
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows file-symlink privilege unavailable'); return;
  }
  const lst = fs.lstatSync(link);
  const stale = Buffer.alloc(lst.size, 0x78);
  rawContentCacheSet(link, lst, stale);
  assert.equal(rawContentCacheGet(link, lst), stale, 'control: a link-identity entry is actually seeded');
  const converted = await convertV4ASectionsToUnifiedPatch(patchFor(link), root);
  assert.match(converted, /-BEFORE/);
  // Clear the seeded entry so absence tests only fresh publication.
  invalidateBuiltinResultCache();
  await convertV4ASectionsToUnifiedPatch(patchFor(link), root);
  assert.equal(rawContentCacheGet(link, lst), null);
});
