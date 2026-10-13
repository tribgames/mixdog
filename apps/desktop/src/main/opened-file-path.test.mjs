// Where an open file lives is read from the open file, never trusted from the
// path it was opened by (opened-file-path.ts).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openedFileLocator, openedFilePath } from './opened-file-path.ts';

const locators = [['this platform', openedFilePath]];

/** A stand-in for koffi's macOS libc: fcntl writes `answer` into its buffer. */
function fakeLibSystem({ answer = '/Users/me/project/out.bin\0', result = 0 } = {}) {
  const calls = [];
  const ffi = {
    load(library) {
      calls.push(['load', library]);
      return {
        func(definition) {
          calls.push(['func', definition]);
          const fcntl = (...args) => {
            calls.push(['call', args[0], args[1], args[2]]);
            if (result !== -1) args[3].write(answer, 'latin1');
            return result;
          };
          return fcntl;
        },
      };
    },
  };
  return { calls, loads: () => calls.filter(([kind]) => kind === 'load').length, foreign: async () => ffi };
}

test('macOS asks fcntl(F_GETPATH) about the descriptor, never the path', async () => {
  const fake = fakeLibSystem();
  const locate = openedFileLocator('darwin', fake.foreign);
  assert.equal(await locate({ fd: 42 }, '/Users/me/project/elsewhere.bin', {}), '/Users/me/project/out.bin');
  assert.equal(await locate({ fd: 43 }, '/ignored', {}), '/Users/me/project/out.bin');
  assert.deepEqual(fake.calls.slice(0, 3), [
    ['load', '/usr/lib/libSystem.B.dylib'],
    ['func', 'int fcntl(int fd, int cmd, ...)'],
    ['call', 42, 50, 'uint8_t *'],
  ]);
  assert.equal(fake.loads(), 1, 'libSystem is loaded once');
});

test('macOS fails closed when fcntl fails or answers nothing usable', async () => {
  for (const options of [{ result: -1 }, { answer: '\0' }, { answer: 'x'.repeat(1024) }]) {
    await assert.rejects(openedFileLocator('darwin', fakeLibSystem(options).foreign)({ fd: 3 }, '/a', {}));
  }
  await assert.rejects(openedFileLocator('darwin', () => Promise.reject(new Error('no koffi')))({ fd: 3 }, '/a', {}));
});

test('a platform without a descriptor-based locator fails closed without loading anything', async () => {
  for (const platform of ['freebsd', 'openbsd', 'sunos', 'aix']) {
    const fake = fakeLibSystem();
    await assert.rejects(openedFileLocator(platform, fake.foreign)({ fd: 3 }, '/a', {}));
    assert.equal(fake.calls.length, 0, platform);
  }
});

test('an open file is located where it really is, and never at a path naming another file', async (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'opened-file-path-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'real'));
  writeFileSync(join(base, 'real', 'file.txt'), 'file');
  writeFileSync(join(base, 'other.txt'), 'other');
  symlinkSync(join(base, 'real'), join(base, 'via'), 'junction');
  const viaJunction = join(base, 'via', 'file.txt');
  const handle = await open(viaJunction, 'r');
  t.after(() => handle.close());
  const identity = await handle.stat({ bigint: true });
  const other = join(base, 'other.txt');
  for (const [label, locate] of locators) {
    assert.equal(await locate(handle, viaJunction, identity), join(base, 'real', 'file.txt'), label);
    assert.notEqual(await locate(handle, other, identity).catch(() => null), other, label);
  }
});
