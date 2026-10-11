import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { differentFieldValue } from './file-version-test-helpers.mjs';

const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-mutation-version-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const { fileVersion, sameFileVersion } = await import('./file-version.mjs');
const { statMatchesSnapshot } = await import('./snapshot-helpers.mjs');
const { hashText } = await import('./hash-utils.mjs');
const { recordReadSnapshot, getReadSnapshot, isSnapshotStale } = await import('./read-snapshot-runtime.mjs');
const { releaseReadSnapshotScope } = await import('./snapshot-store.mjs');
const { atomicWrite } = await import('./atomic-write.mjs');
const { invalidateBuiltinResultCache } = await import('./cache-layers.mjs');
const fields = ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev'];
let sequence = 0;
const scopes = new Set();
test.afterEach(() => invalidateBuiltinResultCache());
test.after(() => {
  for (const scope of scopes) releaseReadSnapshotScope(scope, { deletePersisted: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(content = 'BEFORE\nsecond\n') {
  const path = join(root, `file-${sequence++}.txt`);
  fs.writeFileSync(path, content);
  return { path, content, st: fs.statSync(path) };
}
function scope() {
  const value = `version-${sequence++}`;
  scopes.add(value);
  return value;
}
function changed(st, field) {
  return { ...fileVersion(st), [field]: differentFieldValue(st[field], field) };
}
function hook(t, method, path, fn) {
  const original = fs[method];
  const mocked = t.mock.method(fs, method, (target, ...args) => {
    if (target !== path) return original(target, ...args);
    return fn(() => original(target, ...args));
  });
  syncBuiltinESMExports();
  const restore = () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}
const leftovers = (path) =>
  fs.readdirSync(root).filter((name) => name.startsWith(`.${path.split(/[\\/]/).at(-1)}.mixdog-tmp-`));

for (const field of fields) {
  test(`snapshot fast path rejects an observed ${field} difference`, () => {
    const { st } = fixture();
    const before = fileVersion(st);
    assert.equal(statMatchesSnapshot(st, before), true);
    assert.equal(statMatchesSnapshot(changed(st, field), before), false);
    assert.equal(statMatchesSnapshot(st, changed(st, field)), false);
    for (const invalid of [undefined, NaN, Infinity, String(st[field])]) {
      assert.equal(statMatchesSnapshot({ ...before, [field]: invalid }, before), false);
      assert.equal(statMatchesSnapshot(before, { ...before, [field]: invalid }), false);
    }
  });

  test(`atomic write refuses an observed ${field} difference and preserves the target`, async (t) => {
    const { path, content, st } = fixture();
    hook(t, 'statSync', path, () => changed(st, field));
    await assert.rejects(
      atomicWrite(path, 'EDITED\n', { expectedTargetSnapshot: { exists: true, ...fileVersion(st) } }),
      { code: 'ESTALE_TARGET' }
    );
    assert.equal(fs.readFileSync(path, 'utf8'), content);
    assert.deepEqual(leftovers(path), []);
  });

  test(`snapshot recording does not merge ranges across a ${field} change`, () => {
    const { path, st } = fixture();
    const id = scope();
    recordReadSnapshot(path, st, id, {
      source: 'read',
      ranges: [{ startLine: 1, endLine: 1 }],
      rangeHash: hashText('BEFORE'),
    });
    recordReadSnapshot(path, changed(st, field), id, {
      source: 'read',
      ranges: [{ startLine: 2, endLine: 2 }],
      rangeHash: hashText('second'),
    });
    const snapshot = getReadSnapshot(path, id);
    assert.deepEqual(snapshot.ranges, [{ startLine: 2, endLine: 2 }]);
    assert.equal(snapshot.rangeHashes.length, 1);
    assert.ok(sameFileVersion(snapshot, changed(st, field)));
  });
}

test('recorded and hydrated snapshots own the complete version, ranges and provenance', () => {
  const { path, content, st } = fixture();
  const before = fileVersion(st);
  const id = scope();
  recordReadSnapshot(path, st, id, { source: 'read', contentHash: hashText(content) });
  st.ino = before.ino === 0 ? 1 : 0;
  assert.ok(sameFileVersion(getReadSnapshot(path, id), before));
  releaseReadSnapshotScope(id);
  const hydrated = getReadSnapshot(path, id);
  assert.ok(sameFileVersion(hydrated, before));
  assert.equal(hydrated.ranges[0].endLine, Infinity);
  assert.equal(hydrated.bodyDelivered, true);
  assert.equal(hydrated.contentHash, hashText(content));
});

test('same-version pages still merge and a proven mutation retains body delivery', () => {
  const { path, st, content } = fixture();
  const id = scope();
  for (const line of [1, 2])
    recordReadSnapshot(path, st, id, {
      source: 'read',
      ranges: [{ startLine: line, endLine: line }],
      fileLineCount: 2,
    });
  assert.deepEqual(getReadSnapshot(path, id).ranges, [{ startLine: 1, endLine: 2 }]);
  const after = changed(st, 'ino');
  recordReadSnapshot(path, after, id, { source: 'edit', preMutationStat: st, contentHash: hashText(content) });
  assert.equal(getReadSnapshot(path, id).bodyDelivered, true);
  recordReadSnapshot(path, after, id, {
    source: 'edit',
    preMutationStat: changed(after, 'dev'),
    contentHash: hashText(content),
  });
  assert.equal(getReadSnapshot(path, id).bodyDelivered, false);
});

test('incomplete supplied recording evidence is never filled from a later stat or metadata options', (t) => {
  const { path, st, content } = fixture();
  const id = scope();
  const incomplete = { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size };
  hook(t, 'statSync', path, () => {
    throw new Error('must not relabel the supplied observation');
  });
  recordReadSnapshot(path, incomplete, id, { source: 'read', ...fileVersion(st), contentHash: hashText(content) });
  assert.equal(statMatchesSnapshot(st, getReadSnapshot(path, id)), false);
});

test('failed recording stat does not invent a matching empty-file version', (t) => {
  const { path, st } = fixture('');
  hook(t, 'statSync', path, () => {
    throw Object.assign(new Error('uncertain'), { code: 'EIO' });
  });
  const id = scope();
  recordReadSnapshot(path, null, id, { contentHash: hashText('') });
  assert.equal(statMatchesSnapshot(st, getReadSnapshot(path, id)), false);
});

for (const material of ['full', 'range']) {
  function legacy(st, content) {
    return {
      mtimeMs: st.mtimeMs,
      size: st.size,
      ranges: [{ startLine: 1, endLine: 1 }],
      ...(material === 'full'
        ? { contentHash: hashText(content) }
        : { rangeHashes: [{ startLine: 1, endLine: 1, hash: hashText('BEFORE') }] }),
    };
  }
  test(`${material} hash revalidates a legacy snapshot and upgrades all version fields`, () => {
    const { path, content, st } = fixture();
    const snap = legacy(st, content);
    assert.equal(statMatchesSnapshot(st, snap), false);
    assert.equal(isSnapshotStale(st, snap, path), false);
    assert.ok(sameFileVersion(st, snap));
    assert.equal(snap.ranges[0].endLine, 1, 'hash verification must not widen read coverage');
  });
  test(`${material} hash permits harmless metadata churn but rejects changed content`, () => {
    const { path, content, st } = fixture();
    const snap = { ...legacy(st, content), ...changed(st, 'dev') };
    assert.equal(isSnapshotStale(st, snap, path), false);
    assert.ok(sameFileVersion(st, snap));
    fs.writeFileSync(path, 'CHANGED\nsecond\n');
    assert.equal(isSnapshotStale(fs.statSync(path), snap, path), true);
  });
  test(`${material} hash cannot certify bytes changed during the verification read`, (t) => {
    const { path, content, st } = fixture();
    const snap = legacy(st, content);
    const saved = structuredClone(snap);
    hook(t, 'readFileSync', path, (read) => {
      const observed = read();
      fs.writeFileSync(path, 'REPLACED WHILE READING\n');
      return observed;
    });
    assert.equal(isSnapshotStale(st, snap, path), true);
    assert.deepEqual(snap, saved);
  });
  test(`${material} hash cannot promote a failed post-read stat`, (t) => {
    const { path, content, st } = fixture();
    const snap = legacy(st, content);
    const saved = structuredClone(snap);
    hook(t, 'statSync', path, () => {
      throw Object.assign(new Error('post-stat failure'), { code: 'EIO' });
    });
    assert.equal(isSnapshotStale(st, snap, path), true);
    assert.deepEqual(snap, saved);
  });
}

test('legacy hydration retains hash evidence but malformed identity is rejected', () => {
  const { path, content, st } = fixture();
  for (const invalid of [undefined, '42', null, Infinity]) {
    const id = scope();
    const snap = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      contentHash: hashText(content),
      ranges: [{ startLine: 1, endLine: 2 }],
      ...(invalid === undefined ? {} : { dev: invalid }),
    };
    fs.mkdirSync(join(root, 'data', 'read-snapshots'), { recursive: true });
    fs.writeFileSync(join(root, 'data', 'read-snapshots', `${id}.json`), JSON.stringify({ [path]: snap }));
    const hydrated = getReadSnapshot(path, id);
    if (invalid !== undefined) assert.equal(hydrated, undefined);
    else {
      assert.equal(statMatchesSnapshot(st, hydrated), false);
      assert.equal(isSnapshotStale(st, hydrated, path), false);
      assert.ok(sameFileVersion(st, hydrated));
    }
  }
});

test('exact-version validation adds no file IO; missing evidence cannot authorize it', (t) => {
  const { path, st } = fixture();
  hook(t, 'readFileSync', path, () => {
    throw new Error('fast path must not read');
  });
  hook(t, 'statSync', path, () => {
    throw new Error('fast path must not stat');
  });
  assert.equal(isSnapshotStale(st, fileVersion(st), path), false);
  assert.equal(isSnapshotStale(st, { mtimeMs: st.mtimeMs, size: st.size }, path), true);
  assert.equal(isSnapshotStale(st, null, path), true);
  assert.equal(isSnapshotStale(null, {}, path), true);
});

test('atomic write accepts an exact version for both small and streamed writes', async () => {
  for (const bytes of [Buffer.from('EDITED'), Buffer.alloc(1024 * 1024 + 1, 0x61)]) {
    const { path, st } = fixture();
    await atomicWrite(path, bytes, { expectedTargetSnapshot: { exists: true, ...fileVersion(st) } });
    assert.deepEqual(fs.readFileSync(path), bytes);
    assert.deepEqual(leftovers(path), []);
  }
});

test('atomic write rejects incomplete/non-finite existing-target evidence', async () => {
  const { path, content, st } = fixture();
  for (const field of fields)
    for (const invalid of [undefined, NaN, Infinity, String(st[field])]) {
      await assert.rejects(
        atomicWrite(path, 'EDITED', {
          expectedTargetSnapshot: { exists: true, ...fileVersion(st), [field]: invalid },
        }),
        { code: 'ESTALE_TARGET' }
      );
      assert.equal(fs.readFileSync(path, 'utf8'), content);
      assert.deepEqual(leftovers(path), []);
    }
});

test('atomic write owns expected evidence before its first await', async (t) => {
  const { path, content, st } = fixture();
  const expected = { exists: true, ...fileVersion(st) };
  const after = changed(st, 'ctimeMs');
  const promise = atomicWrite(path, 'EDITED', { expectedTargetSnapshot: expected });
  Object.assign(expected, after); // Must not change the already pending write.
  hook(t, 'statSync', path, () => after);
  await assert.rejects(promise, { code: 'ESTALE_TARGET' });
  assert.equal(fs.readFileSync(path, 'utf8'), content);
  assert.deepEqual(leftovers(path), []);
});

for (const code of ['EIO', 'EACCES'])
  test(`create-only final lookup ${code} is uncertainty, not absence`, async (t) => {
    const { path, content } = fixture();
    const failure = Object.assign(new Error('target unreadable'), { code });
    hook(t, 'statSync', path, () => {
      throw failure;
    });
    await assert.rejects(
      atomicWrite(path, 'EDITED', { expectedTargetSnapshot: { exists: false } }),
      (error) => error === failure
    );
    assert.equal(fs.readFileSync(path, 'utf8'), content);
    assert.deepEqual(leftovers(path), []);
  });

test('explicit absence permits creation but not replacement; removal invalidates an existing version', async () => {
  const { path, content, st } = fixture();
  await assert.rejects(atomicWrite(path, 'EDITED', { expectedTargetSnapshot: { exists: false } }), {
    code: 'ESTALE_TARGET',
  });
  assert.equal(fs.readFileSync(path, 'utf8'), content);
  fs.unlinkSync(path);
  await assert.rejects(atomicWrite(path, 'EDITED', { expectedTargetSnapshot: fileVersion(st) }), {
    code: 'ESTALE_TARGET',
  });
  assert.equal(fs.existsSync(path), false);
  await atomicWrite(path, 'CREATED', { expectedTargetSnapshot: { exists: false } });
  assert.equal(fs.readFileSync(path, 'utf8'), 'CREATED');
  assert.deepEqual(leftovers(path), []);
});
