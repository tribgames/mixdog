import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  copyProjectEntryIn,
  createProjectEntryIn,
  moveProjectEntryIn,
  renameProjectEntryIn,
  writeProjectTextFileIn as save,
  writeProjectTextFilesIn as saveMany,
} from './project-files.ts';

// Only leaf IO is paused/faulted. Public operations, path guards, mutation
// ownership, compare checks, actual temp files and renames all run unchanged.
async function fixture(t, files = { 'a.txt': 'initial' }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-file-mutations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(root, name, '..'), { recursive: true });
    await fs.writeFile(join(root, name), content);
  }
  return root;
}

function replaceBuiltin(t, object, name, implementation) {
  const original = object[name];
  const mocked = t.mock.method(object, name, (...args) => implementation(original, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

function pauseRead(t, file) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  let reads = 0;
  replaceBuiltin(t, fs, 'readFile', async (read, path, ...args) => {
    const index = String(path) === file ? ++reads : 0;
    const bytes = await read(path, ...args);
    if (index === 1) {
      entered.resolve();
      await released.promise;
    }
    return bytes;
  });
  return { entered: entered.promise, release: released.resolve, get reads() { return reads; } };
}

async function assertClean(root) {
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.mixdog-save-')), []);
}

for (const rel of ['a.txt', './a.txt']) {
  test(`same-version saves are serialized before reading (${rel})`, { timeout: 5000 }, async (t) => {
    const root = await fixture(t);
    const gate = pauseRead(t, join(root, 'a.txt'));
    const first = save(root, 'a.txt', 'first', 'initial');
    await gate.entered;
    const second = save(root, rel, 'second', 'initial');
    const finished = Promise.allSettled([first, second]);
    try {
      assert.equal(gate.reads, 1, 'the queued save must not observe the old version');
    } finally {
      gate.release();
      await finished;
    }
    const [a, b] = await finished;
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.match(b.reason.message, /changed on disk/);
    assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'first');
    await assertClean(root);
  });
}

test('root aliases share save ownership without replacing the directory link', { timeout: 5000 }, async (t) => {
  const outer = await fixture(t, { 'real/a.txt': 'initial' });
  const root = join(outer, 'real');
  const alias = join(outer, 'alias');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const gate = pauseRead(t, join(root, 'a.txt'));
  const first = save(root, 'a.txt', 'first', 'initial');
  await gate.entered;
  const second = save(alias, 'a.txt', 'second', 'initial');
  const finished = Promise.allSettled([first, second]);
  gate.release();
  const [a, b] = await finished;
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(await fs.readFile(join(alias, 'a.txt'), 'utf8'), 'first');
  assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
});

test('a paused save does not block a disjoint file', { timeout: 5000 }, async (t) => {
  const root = await fixture(t, { 'a.txt': 'initial', 'b.txt': 'other' });
  const gate = pauseRead(t, join(root, 'a.txt'));
  const first = save(root, 'a.txt', 'first', 'initial');
  await gate.entered;
  try {
    await save(root, 'b.txt', 'independent', 'other');
    assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'independent');
  } finally {
    gate.release();
    await first;
  }
});

test('successful consecutive saves work with a frozen wall clock and leave no scratch files', async (t) => {
  const root = await fixture(t);
  t.mock.method(Date, 'now', () => 12345);
  await save(root, 'a.txt', 'first', 'initial');
  await save(root, 'a.txt', 'second', 'first');
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'second');
  await assertClean(root);
});

test('an exclusive temp-name collision neither overwrites nor removes the existing file', async (t) => {
  const root = await fixture(t);
  replaceBuiltin(t, crypto, 'randomUUID', () => 'collision');
  const temp = join(root, `a.txt.mixdog-save-${process.pid}-collision`);
  await fs.writeFile(temp, 'belongs to somebody else');
  await assert.rejects(save(root, 'a.txt', 'next', 'initial'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(temp, 'utf8'), 'belongs to somebody else');
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'initial');
});

test('partial temp write failure closes the handle, cleans only owned temp, and releases the claim', async (t) => {
  const root = await fixture(t);
  let handle;
  let fault = true;
  replaceBuiltin(t, fs, 'open', async (open, path, ...args) => {
    const result = await open(path, ...args);
    if (fault && String(path).includes('.mixdog-save-')) {
      fault = false;
      handle = result;
      const write = result.writeFile.bind(result);
      t.mock.method(result, 'writeFile', async () => {
        await write('partial');
        throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
      });
    }
    return result;
  });
  await assert.rejects(save(root, 'a.txt', 'next', 'initial'), { code: 'ENOSPC' });
  assert.equal(handle.fd, -1);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'initial');
  await assertClean(root);
  await save(root, 'a.txt', 'recovered', 'initial');
});

test('failed replacement preserves original contents and allows a later save', async (t) => {
  const root = await fixture(t);
  let fail = true;
  replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
    if (fail && String(from).includes('.mixdog-save-')) {
      fail = false;
      throw Object.assign(new Error('injected rename failure'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  await assert.rejects(save(root, 'a.txt', 'next', 'initial'), { code: 'EPERM' });
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'initial');
  await assertClean(root);
  await save(root, 'a.txt', 'recovered', 'initial');
});

test('external edits before the final compare still fail the content check', async (t) => {
  const root = await fixture(t);
  let reads = 0;
  replaceBuiltin(t, fs, 'readFile', async (read, path, ...args) => {
    if (String(path) === join(root, 'a.txt') && ++reads === 2) {
      await fs.writeFile(path, 'external');
    }
    return read(path, ...args);
  });
  await assert.rejects(save(root, 'a.txt', 'next', 'initial'), /changed on disk/);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'external');
  await assertClean(root);
});

for (const entry of ['a.txt', 'dir']) {
  test(`rename waits for an overlapping save (${entry})`, { timeout: 5000 }, async (t) => {
    const rel = entry === 'dir' ? 'dir/a.txt' : 'a.txt';
    const root = await fixture(t, { [rel]: 'initial' });
    const gate = pauseRead(t, join(root, rel));
    let renames = 0;
    replaceBuiltin(t, fs, 'rename', (rename, from, to) => {
      if (String(from) === join(root, entry)) renames++;
      return rename(from, to);
    });
    const writing = save(root, rel, 'saved', 'initial');
    await gate.entered;
    const renaming = renameProjectEntryIn(root, entry, 'renamed');
    const finished = Promise.allSettled([writing, renaming]);
    try {
      assert.equal(renames, 0, 'rename must not invalidate the in-flight save');
    } finally {
      gate.release();
      await finished;
    }
    assert.deepEqual((await finished).map((result) => result.status), ['fulfilled', 'fulfilled']);
    const moved = entry === 'dir' ? 'renamed/a.txt' : 'renamed';
    assert.equal(await fs.readFile(join(root, moved), 'utf8'), 'saved');
    await assert.rejects(fs.stat(join(root, rel)), { code: 'ENOENT' });
  });
}

test('a save queued behind a rename cannot recreate the old file', { timeout: 5000 }, async (t) => {
  const root = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
    if (String(from) === join(root, 'a.txt')) {
      entered.resolve();
      await release.promise;
    }
    return rename(from, to);
  });
  const renaming = renameProjectEntryIn(root, 'a.txt', 'renamed.txt');
  await entered.promise;
  const writing = save(root, 'a.txt', 'stale save', 'initial');
  const finished = Promise.allSettled([renaming, writing]);
  release.resolve();
  const [a, b] = await finished;
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  await assert.rejects(fs.stat(join(root, 'a.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(join(root, 'renamed.txt'), 'utf8'), 'initial');
});

test('rename refuses an existing file without changing either file', async (t) => {
  const root = await fixture(t, { 'a.txt': 'source', 'b.txt': 'destination' });
  await assert.rejects(renameProjectEntryIn(root, 'a.txt', 'b.txt'), /already exists/);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'source');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'destination');
});

test('rename refuses even an empty existing destination directory', async (t) => {
  const root = await fixture(t, { 'source/child.txt': 'source' });
  await fs.mkdir(join(root, 'destination'));
  await assert.rejects(renameProjectEntryIn(root, 'source', 'destination'), /already exists/);
  assert.equal(await fs.readFile(join(root, 'source/child.txt'), 'utf8'), 'source');
  assert.deepEqual(await fs.readdir(join(root, 'destination')), []);
});

test('concurrent renames to one destination have one winner and preserve the losing source', async (t) => {
  const root = await fixture(t, { 'a.txt': 'A', 'b.txt': 'B' });
  const results = await Promise.allSettled([
    renameProjectEntryIn(root, 'a.txt', 'target.txt'),
    renameProjectEntryIn(root, 'b.txt', 'target.txt'),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.equal(await fs.readFile(join(root, 'target.txt'), 'utf8'), 'A');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B');
});

test('same-name and case-only renames remain valid on the actual filesystem', async (t) => {
  const root = await fixture(t);
  await renameProjectEntryIn(root, 'a.txt', 'a.txt');
  await renameProjectEntryIn(root, 'a.txt', 'A.txt');
  assert.ok((await fs.readdir(root)).includes('A.txt'));
  assert.equal(await fs.readFile(join(root, 'A.txt'), 'utf8'), 'initial');
});

test('a distinct case-variant entry is not treated as a case-only rename', async (t) => {
  const root = await fixture(t);
  try {
    await fs.writeFile(join(root, 'A.txt'), 'other', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    t.skip('case-insensitive fixture filesystem');
    return;
  }
  await assert.rejects(renameProjectEntryIn(root, 'a.txt', 'A.txt'), /already exists/);
  assert.equal(await fs.readFile(join(root, 'A.txt'), 'utf8'), 'other');
});

test('a distinct hardlink destination is still occupied', async (t) => {
  const root = await fixture(t);
  await fs.link(join(root, 'a.txt'), join(root, 'b.txt'));
  await assert.rejects(renameProjectEntryIn(root, 'a.txt', 'b.txt'), /already exists/);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'initial');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'initial');
});

test('a dangling symlink is an occupied rename destination', async (t) => {
  const root = await fixture(t);
  try {
    await fs.symlink(join(root, 'missing.txt'), join(root, 'b.txt'), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows host does not grant file-symlink privilege');
    return;
  }
  await assert.rejects(renameProjectEntryIn(root, 'a.txt', 'b.txt'), /already exists/);
  assert.equal((await fs.lstat(join(root, 'b.txt'))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'initial');
});

test('destination stat errors fail closed, not as absence', async (t) => {
  const root = await fixture(t);
  replaceBuiltin(t, fs, 'lstat', (lstat, path, ...args) => {
    if (String(path) === join(root, 'b.txt')) {
      throw Object.assign(new Error('injected access denied'), { code: 'EACCES' });
    }
    return lstat(path, ...args);
  });
  await assert.rejects(renameProjectEntryIn(root, 'a.txt', 'b.txt'), { code: 'EACCES' });
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'initial');
});

test('rename keeps normalized backslash paths in the original directory', async (t) => {
  const root = await fixture(t, { 'nested/a.txt': 'initial' });
  await renameProjectEntryIn(root, 'nested\\a.txt', 'b.txt');
  assert.equal(await fs.readFile(join(root, 'nested/b.txt'), 'utf8'), 'initial');
  await assert.rejects(fs.stat(join(root, 'b.txt')), { code: 'ENOENT' });
});

for (const operation of ['create', 'move', 'copy']) {
  test(`${operation} participates in rename destination ownership`, { timeout: 5000 }, async (t) => {
    const root = await fixture(t, { 'source.txt': 'source', 'other/target.txt': 'other' });
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
      if (String(from) === join(root, 'source.txt')) {
        entered.resolve();
        await release.promise;
      }
      return rename(from, to);
    });
    const renaming = renameProjectEntryIn(root, 'source.txt', 'target.txt');
    await entered.promise;
    const competing = operation === 'create'
      ? createProjectEntryIn(root, '', 'target.txt', false)
      : operation === 'move'
        ? moveProjectEntryIn(root, 'other/target.txt', '')
        : copyProjectEntryIn(root, 'other/target.txt', '');
    const finished = Promise.allSettled([renaming, competing]);
    release.resolve();
    const results = await finished;
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(await fs.readFile(join(root, 'target.txt'), 'utf8'), 'source');
    assert.equal(await fs.readFile(join(root, 'other/target.txt'), 'utf8'), 'other');
    if (operation === 'copy') {
      assert.equal(results[1].status, 'fulfilled');
      assert.equal(results[1].value.name, 'target copy.txt');
      assert.equal(await fs.readFile(join(root, 'target copy.txt'), 'utf8'), 'other');
    } else {
      assert.equal(results[1].status, 'rejected');
    }
  });
}

test('a batch owns every target until all writes finish', { timeout: 5000 }, async (t) => {
  const root = await fixture(t, { 'a.txt': 'A0', 'b.txt': 'B0' });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let bReads = 0;
  replaceBuiltin(t, fs, 'readFile', (read, path, ...args) => {
    if (String(path) === join(root, 'b.txt')) bReads++;
    return read(path, ...args);
  });
  replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
    await rename(from, to);
    if (String(to) === join(root, 'a.txt')) {
      entered.resolve();
      await release.promise;
    }
  });
  const batch = saveMany(root, [
    { relPath: 'a.txt', content: 'A1', expectedContent: 'A0' },
    { relPath: 'b.txt', content: 'B1', expectedContent: 'B0' },
  ]);
  await entered.promise;
  const single = save(root, 'b.txt', 'single', 'B0');
  const finished = Promise.allSettled([batch, single]);
  try {
    assert.equal(bReads, 1, 'only batch preflight may have read b');
  } finally {
    release.resolve();
    await finished;
  }
  assert.deepEqual((await finished).map((result) => result.status), ['fulfilled', 'rejected']);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A1');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B1');
});

test('batch rollback completes before a queued save reads the restored version', { timeout: 5000 }, async (t) => {
  const root = await fixture(t, { 'a.txt': 'A0', 'b.txt': 'B0' });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  replaceBuiltin(t, fs, 'rename', async (rename, from, to) => {
    if (String(to) === join(root, 'b.txt')) {
      entered.resolve();
      await release.promise;
      throw new Error('injected second-file failure');
    }
    return rename(from, to);
  });
  const batch = saveMany(root, [
    { relPath: 'a.txt', content: 'A1', expectedContent: 'A0' },
    { relPath: 'b.txt', content: 'B1', expectedContent: 'B0' },
  ]);
  const batchResult = Promise.allSettled([batch]);
  await entered.promise;
  const single = save(root, 'a.txt', 'A2', 'A0');
  const singleResult = Promise.allSettled([single]);
  release.resolve();
  assert.equal((await batchResult)[0].status, 'rejected');
  assert.equal((await singleResult)[0].status, 'fulfilled');
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A2');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B0');
  await assertClean(root);
});

test('opposite-order overlapping batches settle without deadlock', { timeout: 5000 }, async (t) => {
  const root = await fixture(t, { 'a.txt': 'A0', 'b.txt': 'B0' });
  const writes = [
    { relPath: 'a.txt', content: 'A1', expectedContent: 'A0' },
    { relPath: 'b.txt', content: 'B1', expectedContent: 'B0' },
  ];
  const results = await Promise.allSettled([saveMany(root, writes), saveMany(root, [...writes].reverse())]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A1');
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'B1');
});


test('a retargeted directory alias cannot redirect a queued save outside its claim', { timeout: 5000 }, async (t) => {
  const root = await fixture(t, { 'one/a.txt': 'one', 'two/a.txt': 'two' });
  const alias = join(root, 'alias');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(join(root, 'one'), alias, kind);
  const gate = pauseRead(t, join(root, 'one/a.txt'));
  const first = save(root, 'one/a.txt', 'saved one', 'one');
  await gate.entered;
  const second = save(root, 'alias/a.txt', 'must not land', 'two');
  const finished = Promise.allSettled([first, second]);
  try {
    await fs.unlink(alias);
    await fs.symlink(join(root, 'two'), alias, kind);
  } finally {
    gate.release();
    await finished;
  }
  const [a, b] = await finished;
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.match(b.reason.message, /Project path changed/);
  assert.equal(await fs.readFile(join(root, 'two/a.txt'), 'utf8'), 'two');
});

for (const [encoding, before, after] of [
  ['utf8bom', Buffer.from([0xef, 0xbb, 0xbf, 65]), Buffer.from([0xef, 0xbb, 0xbf, 66])],
  ['utf16le', Buffer.from([0xff, 0xfe, 65, 0]), Buffer.from([0xff, 0xfe, 66, 0])],
  ['utf16be', Buffer.from([0xfe, 0xff, 0, 65]), Buffer.from([0xfe, 0xff, 0, 66])],
]) {
  test(`serialized saves preserve existing ${encoding} encoding behavior`, async (t) => {
    const root = await fixture(t, { 'a.txt': before });
    await save(root, 'a.txt', 'B', 'A');
    assert.deepEqual(await fs.readFile(join(root, 'a.txt')), after);
  });
}
