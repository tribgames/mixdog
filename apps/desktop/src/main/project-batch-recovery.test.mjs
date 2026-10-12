import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { writeProjectTextFileIn as save, writeProjectTextFilesIn as saveMany } from './project-files.ts';
import { replaceWorkspaceTextIn } from './workspace-search.ts';
import { DesktopServiceClient } from './desktop-service-client.ts';

// Public writers, mutation ownership and real file IO are retained. Faults
// are injected only at leaf IO, at deterministic pre/post-rename boundaries.
async function fixture(t, files = { 'a.txt': 'A0', 'b.txt': 'B0', 'c.txt': 'C0' }) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mixdog-batch-recovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [rel, bytes] of Object.entries(files)) {
    await fs.mkdir(join(root, rel, '..'), { recursive: true });
    await fs.writeFile(join(root, rel), bytes);
  }
  return root;
}
function fault(message, code = 'EIO') { return Object.assign(new Error(message), { code }); }
function replaceBuiltin(t, object, name, impl) {
  const original = object[name];
  const hook = t.mock.method(object, name, (...args) => impl(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { hook.mock.restore(); syncBuiltinESMExports(); });
}
function writes(...names) {
  return names.map((name) => ({ relPath: `${name}.txt`, content: `${name.toUpperCase()}1`, expectedContent: `${name.toUpperCase()}0` }));
}
async function rejection(promise) {
  let reason;
  await assert.rejects(promise, (error) => { reason = error; return true; });
  return reason;
}
async function clean(root) {
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.mixdog-save-')), []);
}
function outcome(error, cause, failedPath, committedPaths, restoredPaths, unrestoredPaths) {
  assert.equal(error.name, 'ProjectTextBatchWriteError');
  assert.equal(error.cause, cause, 'keep the original failure object');
  assert.equal(error.code, unrestoredPaths.length ? 'EPARTIAL_WRITE' : 'EWORKSPACE_WRITE');
  assert.deepEqual(error.result, { failedPath, committedPaths, restoredPaths, unrestoredPaths });
  assert.match(error.message, new RegExp(cause.message));
  assert.ok(error.message.includes(JSON.stringify(failedPath)));
}

test('a successful batch preserves the void result and leaves no scratch files', async (t) => {
  const root = await fixture(t);
  assert.equal(await saveMany(root, writes('a', 'b')), undefined);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A1');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B1');
  await clean(root);
});

test('failure before the first commit preserves the original error and every file', async (t) => {
  const root = await fixture(t);
  const cause = fault('first rename denied', 'EPERM');
  replaceBuiltin(t, fs, 'rename', () => { throw cause; });
  assert.equal(await rejection(saveMany(root, writes('a', 'b'))), cause);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A0');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B0');
  await clean(root);
});

for (const at of ['a', 'b', 'c']) for (const code of ['EIO', 'EACCES']) {
  test(`post-rename ${code} at ${at} is recorded and recovered despite unavailable metadata`, async (t) => {
    const root = await fixture(t);
    const path = join(root, `${at}.txt`);
    const cause = fault('committed file metadata unavailable', code);
    const swaps = [];
    let committed = false;
    replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
      await rename(from, to);
      swaps.push(basename(to));
      if (to === path) committed = true;
    });
    replaceBuiltin(t, fs, 'stat', (stat, file, ...args) => {
      // Persistent failure: recovery must not need metadata from this path.
      if (file === path && committed) throw cause;
      return stat(file, ...args);
    });
    const error = await rejection(saveMany(root, writes('a', 'b', 'c')));
    const paths = ['a.txt', 'b.txt', 'c.txt'].slice(0, ['a', 'b', 'c'].indexOf(at) + 1);
    for (const name of ['a', 'b', 'c']) assert.equal(await fs.readFile(join(root, `${name}.txt`), 'utf8'), `${name.toUpperCase()}0`);
    outcome(error, cause, `${at}.txt`, paths, paths, []);
    assert.deepEqual(error.rollbackFailures, []);
    assert.deepEqual(swaps, [...paths, ...[...paths].reverse()]);
    await clean(root);
  });
}

for (const [before, external] of [[0o644, 0o600], [0o600, 0o666]]) {
  test(`rollback preserves newer POSIX permissions ${before.toString(8)} to ${external.toString(8)}`, {
    skip: process.platform === 'win32' ? 'POSIX mode bits are not supported on Windows' : false,
  }, async (t) => {
    // Do not let umask accidentally make the old saved mode equal the newer
    // restrictive mode; separately prove wider permissions survive a tight mask.
    const previousMask = process.umask(external === 0o600 ? 0o022 : 0o077);
    t.after(() => process.umask(previousMask));
    const root = await fixture(t);
    const file = join(root, 'a.txt');
    await fs.chmod(file, before);
    const cause = fault('second write failed after external chmod');
    replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
      if (to === join(root, 'b.txt')) {
        assert.equal(await fs.readFile(file, 'utf8'), 'A1', 'first write already committed');
        await fs.chmod(file, external);
        throw cause;
      }
      return rename(from, to);
    });
    const error = await rejection(saveMany(root, writes('a', 'b')));
    outcome(error, cause, 'b.txt', ['a.txt'], ['a.txt'], []);
    assert.equal(await fs.readFile(file, 'utf8'), 'A0');
    assert.equal((await fs.stat(file)).mode & 0o777, external);
    assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B0');
    await clean(root);
  });
}

test('rollback falls back to the saved mode when current metadata is unavailable', async (t) => {
  const root = await fixture(t);
  const file = join(root, 'a.txt');
  await fs.chmod(file, 0o600);
  const inspect = fs.stat;
  const before = (await inspect(file)).mode & 0o777;
  const cause = fault('second write failed before metadata fallback');
  let recovering = false;
  let metadataAttempts = 0;
  replaceBuiltin(t, fs, 'rename', (rename, from, to) => {
    if (to === join(root, 'b.txt')) { recovering = true; throw cause; }
    return rename(from, to);
  });
  replaceBuiltin(t, fs, 'stat', (stat, path, ...args) => {
    if (recovering && path === file) {
      metadataAttempts++;
      throw fault('rollback metadata unavailable', 'EACCES');
    }
    return stat(path, ...args);
  });
  const error = await rejection(saveMany(root, writes('a', 'b')));
  outcome(error, cause, 'b.txt', ['a.txt'], ['a.txt'], []);
  assert.equal(metadataAttempts, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'A0');
  assert.equal((await inspect(file)).mode & 0o777, before);
  await clean(root);
});

test('partial rollback reports original and recovery failures and continues recovering earlier files', async (t) => {
  const root = await fixture(t);
  const cause = fault('third replacement failed');
  const recovery = fault('second file recovery denied', 'EPERM');
  const swaps = [];
  let failing = false;
  replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
    swaps.push(basename(to));
    if (to === join(root, 'c.txt')) { failing = true; throw cause; }
    if (failing && to === join(root, 'b.txt')) throw recovery;
    return rename(from, to);
  });
  const error = await rejection(saveMany(root, writes('a', 'b', 'c')));
  outcome(error, cause, 'c.txt', ['a.txt', 'b.txt'], ['a.txt'], ['b.txt']);
  assert.deepEqual(error.rollbackFailures, [{ relPath: 'b.txt', cause: recovery }]);
  assert.deepEqual(swaps, ['a.txt', 'b.txt', 'c.txt', 'b.txt', 'a.txt']);
  assert.match(error.message, /Rollback incomplete.*second file recovery denied.*before retrying/);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A0');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B1');
  assert.equal(await fs.readFile(join(root, 'c.txt'), 'utf8'), 'C0');
  await clean(root);
});

test('every rollback failure is retained in reverse recovery order', async (t) => {
  const root = await fixture(t);
  const cause = fault('third write rejected');
  const failures = { 'a.txt': fault('no space', 'ENOSPC'), 'b.txt': fault('denied', 'EACCES') };
  let failing = false;
  replaceBuiltin(t, fs, 'rename', (rename, from, to) => {
    if (to === join(root, 'c.txt')) { failing = true; throw cause; }
    if (failing) throw failures[basename(to)];
    return rename(from, to);
  });
  const error = await rejection(saveMany(root, writes('a', 'b', 'c')));
  outcome(error, cause, 'c.txt', ['a.txt', 'b.txt'], [], ['a.txt', 'b.txt']);
  assert.deepEqual(error.rollbackFailures, ['b.txt', 'a.txt'].map((relPath) => ({ relPath, cause: failures[relPath] })));
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A1');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B1');
  await clean(root);
});

for (const change of ['text', 'BOM', 'delete']) {
  test(`rollback preserves a newer external ${change} change`, async (t) => {
    const root = await fixture(t);
    const file = join(root, 'a.txt');
    const cause = fault('second write failed');
    const external = change === 'BOM' ? Buffer.from('\ufeffA1') : Buffer.from('EXTERNAL');
    replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
      if (to === join(root, 'b.txt')) {
        if (change === 'delete') await fs.unlink(file); else await fs.writeFile(file, external);
        throw cause;
      }
      return rename(from, to);
    });
    const error = await rejection(saveMany(root, writes('a', 'b')));
    outcome(error, cause, 'b.txt', ['a.txt'], [], ['a.txt']);
    assert.equal(error.rollbackFailures.length, 1);
    if (change === 'delete') await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    else assert.deepEqual(await fs.readFile(file), external);
    await clean(root);
  });
}

test('external change during rollback temporary IO is not overwritten', async (t) => {
  const root = await fixture(t);
  const cause = fault('second swap failed');
  let recovering = false;
  replaceBuiltin(t, fs, 'rename', (rename, from, to) => {
    if (to === join(root, 'b.txt')) { recovering = true; throw cause; }
    return rename(from, to);
  });
  replaceBuiltin(t, fs, 'open', async (open, file, ...args) => {
    const handle = await open(file, ...args);
    if (recovering && String(file).includes('.mixdog-save-')) {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (...args) => {
        await write(...args);
        await fs.writeFile(join(root, 'a.txt'), 'EXTERNAL DURING RECOVERY');
      });
    }
    return handle;
  });
  const error = await rejection(saveMany(root, writes('a', 'b')));
  outcome(error, cause, 'b.txt', ['a.txt'], [], ['a.txt']);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'EXTERNAL DURING RECOVERY');
  await clean(root);
});

for (const distinctCase of [false, true]) for (const changeDuringTemp of [false, true]) {
  test(`rollback rejects a retargeted ${distinctCase ? 'case-distinct ' : ''}directory alias (${changeDuringTemp ? 'during' : 'before'} temporary IO)`, async (t) => {
    const original = distinctCase ? 'A' : 'one';
    const other = distinctCase ? 'a' : 'two';
    const root = await fixture(t, { [`${original}/a.txt`]: 'A0', 'b.txt': 'B0' });
    await fs.mkdir(join(root, other), { recursive: true });
    if (distinctCase && await fs.realpath(join(root, original)) === await fs.realpath(join(root, other))) {
      t.skip('fixture filesystem does not support distinct case-variant directories');
      return;
    }
    await fs.writeFile(join(root, other, 'a.txt'), 'A1');
    const alias = join(root, 'alias');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(join(root, original), alias, kind);
    const retarget = async () => { await fs.unlink(alias); await fs.symlink(join(root, other), alias, kind); };
    const cause = fault('second swap failed');
    let recovering = false;
    replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
      if (to === join(root, 'b.txt')) {
        recovering = true;
        if (!changeDuringTemp) await retarget();
        throw cause;
      }
      return rename(from, to);
    });
    replaceBuiltin(t, fs, 'open', async (open, file, ...args) => {
      const handle = await open(file, ...args);
      if (recovering && changeDuringTemp) {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (...args) => { await write(...args); await retarget(); });
      }
      return handle;
    });
    const error = await rejection(saveMany(root, [{ relPath: 'alias/a.txt', content: 'A1', expectedContent: 'A0' }, ...writes('b')]));
    outcome(error, cause, 'b.txt', ['alias/a.txt'], [], ['alias/a.txt']);
    assert.match(error.rollbackFailures[0].cause.message, /path changed before rollback/);
    assert.equal(await fs.readFile(join(root, original, 'a.txt'), 'utf8'), 'A1');
    assert.equal(await fs.readFile(join(root, other, 'a.txt'), 'utf8'), 'A1');
    await clean(join(root, original));
    await clean(join(root, other));
  });
}

for (const [name, bytes] of [
  ['utf8bom', Buffer.from('\ufeffALPHA\r\nBETA\n')],
  ['utf16le-no-bom', Buffer.from('ALPHA\r\nBETA\n', 'utf16le')],
  ['utf16be-no-bom', Buffer.from('ALPHA\r\nBETA\n', 'utf16le').swap16()],
]) {
  test(`successful rollback restores exact original ${name} bytes`, async (t) => {
    const root = await fixture(t, { 'a.txt': bytes, 'b.txt': 'B0' });
    const cause = fault('second file blocked');
    replaceBuiltin(t, fs, 'rename', (rename, from, to) => {
      if (to === join(root, 'b.txt')) throw cause;
      return rename(from, to);
    });
    const error = await rejection(saveMany(root, [{ relPath: 'a.txt', content: 'CHANGED\n', expectedContent: 'ALPHA\r\nBETA\n' }, ...writes('b')]));
    assert.deepEqual(await fs.readFile(join(root, 'a.txt')), bytes);
    outcome(error, cause, 'b.txt', ['a.txt'], ['a.txt'], []);
    await clean(root);
  });
}

test('partial recovery write failure closes its handle and removes owned scratch', async (t) => {
  const root = await fixture(t);
  const cause = fault('second swap failed');
  const recovery = fault('recovery write full', 'ENOSPC');
  let recovering = false;
  let rollbackHandle;
  replaceBuiltin(t, fs, 'rename', (rename, from, to) => {
    if (to === join(root, 'b.txt')) { recovering = true; throw cause; }
    return rename(from, to);
  });
  replaceBuiltin(t, fs, 'open', async (open, file, ...args) => {
    const handle = await open(file, ...args);
    if (recovering) {
      rollbackHandle = handle;
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async () => { await write('partial'); throw recovery; });
    }
    return handle;
  });
  const error = await rejection(saveMany(root, writes('a', 'b')));
  outcome(error, cause, 'b.txt', ['a.txt'], [], ['a.txt']);
  assert.equal(error.rollbackFailures[0].cause, recovery);
  assert.equal(rollbackHandle.fd, -1);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A1');
  await clean(root);
});

test('recovery temp collision preserves the foreign scratch file', async (t) => {
  const root = await fixture(t);
  const cause = fault('second file failed');
  const foreign = join(root, `a.txt.mixdog-save-${process.pid}-collision`);
  replaceBuiltin(t, crypto, 'randomUUID', () => 'collision');
  replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
    if (to === join(root, 'b.txt')) { await fs.writeFile(foreign, 'FOREIGN'); throw cause; }
    return rename(from, to);
  });
  const error = await rejection(saveMany(root, writes('a', 'b')));
  outcome(error, cause, 'b.txt', ['a.txt'], [], ['a.txt']);
  assert.equal(error.rollbackFailures[0].cause.code, 'EEXIST');
  assert.equal(await fs.readFile(foreign, 'utf8'), 'FOREIGN');
});

test('partial recovery holds all claims until settlement and a later save can proceed', { timeout: 5000 }, async (t) => {
  const root = await fixture(t);
  const cause = fault('third failed');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let recovering = false;
  replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
    if (!recovering && to === join(root, 'c.txt')) { recovering = true; throw cause; }
    if (recovering && to === join(root, 'b.txt')) throw fault('second recovery denied', 'EPERM');
    if (recovering && to === join(root, 'a.txt')) { entered.resolve(); await release.promise; }
    return rename(from, to);
  });
  const batch = rejection(saveMany(root, writes('a', 'b', 'c')));
  await entered.promise;
  let read = false;
  replaceBuiltin(t, fs, 'readFile', (readFile, file, ...args) => {
    if (file === join(root, 'c.txt')) read = true;
    return readFile(file, ...args);
  });
  const next = save(root, 'c.txt', 'QUEUED', 'C0');
  const settled = Promise.allSettled([next]);
  try { await Promise.resolve(); assert.equal(read, false); } finally { release.resolve(); }
  outcome(await batch, cause, 'c.txt', ['a.txt', 'b.txt'], ['a.txt'], ['b.txt']);
  assert.equal((await settled)[0].status, 'fulfilled');
  assert.equal(await fs.readFile(join(root, 'c.txt'), 'utf8'), 'QUEUED');
  await clean(root);
});

test('workspace replace propagates partial recovery instead of reporting changed counts', async (t) => {
  const root = await fixture(t, { 'a.txt': 'needle', 'b.txt': 'needle' });
  const cause = fault('workspace second write failed');
  let recovering = false;
  replaceBuiltin(t, fs, 'rename', (rename, from, to) => {
    if (to === join(root, 'b.txt')) { recovering = true; throw cause; }
    if (recovering) throw fault('workspace recovery denied', 'EPERM');
    return rename(from, to);
  });
  const error = await rejection(replaceWorkspaceTextIn(root,
    { query: 'needle', regex: false, caseSensitive: true, wholeWord: false, includeIgnored: false }, 'updated', undefined));
  outcome(error, cause, 'b.txt', ['a.txt'], [], ['a.txt']);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'updated');
});

test('partial recovery survives the existing message-only service error boundary', async (t) => {
  const root = await fixture(t);
  const cause = fault('transport second write failed');
  let recovering = false;
  replaceBuiltin(t, fs, 'rename', (rename, from, to) => {
    if (to === join(root, 'b.txt')) { recovering = true; throw cause; }
    if (recovering) throw fault('transport recovery denied', 'EPERM');
    return rename(from, to);
  });
  const failure = await rejection(saveMany(root, writes('a', 'b')));
  class Transport extends EventEmitter {
    postMessage(message) {
      if (message.kind === 'init') queueMicrotask(() => this.emit('message', { kind: 'ready' }));
      if (message.kind === 'request') queueMicrotask(() => this.emit('message', {
        kind: 'response', id: message.id, ok: false,
        // Deliberately only the fields the current service protocol carries.
        error: JSON.parse(JSON.stringify({ name: failure.name, message: failure.message, code: failure.code })),
      }));
    }
    async close() {}
  }
  const client = new DesktopServiceClient({ connect: () => new Transport(), sessionOptions: () => ({ userDataPath: root, packaged: false }) });
  try {
    const error = await rejection(client.invokeDesktopOperation('writeProjectTextFilesIn', [root, writes('a', 'b')]));
    assert.equal(error.code, 'EPARTIAL_WRITE');
    assert.equal(error.message, failure.message);
    assert.match(error.message, /Rollback incomplete.*"a.txt".*transport recovery denied/);
    assert.match(error.message, /Committed: \["a.txt"\]. Restored: \[\]/);
    assert.equal(error.result, undefined, 'do not rely on custom fields surviving the protocol');
  } finally { await client.dispose(); }
});
