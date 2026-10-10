import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSnapshotBudget,
  describeOmittedFile,
  detectTextCodec,
  looksBinary,
  PATCH_SNAPSHOT_MAX_BYTES,
  readBoundedFile,
} from './bounded-file-read.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-bounded-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('present, absent, oversized and non-regular targets are distinct states', (t) => {
  const dir = fixture(t);
  const text = join(dir, 'a.txt');
  writeFileSync(text, 'hello\n');
  const read = readBoundedFile(text);
  assert.equal(read.state, 'present');
  assert.equal(read.content.toString('utf8'), 'hello\n');
  assert.equal(read.size, 6);

  const empty = join(dir, 'empty.txt');
  writeFileSync(empty, '');
  const emptyRead = readBoundedFile(empty);
  assert.equal(emptyRead.state, 'present');
  assert.equal(emptyRead.content.length, 0);

  assert.deepEqual(readBoundedFile(join(dir, 'missing.txt')), { state: 'absent' });

  const big = join(dir, 'big.txt');
  writeFileSync(big, 'x'.repeat(1024));
  const oversized = readBoundedFile(big, { maxBytes: 100 });
  assert.equal(oversized.state, 'omitted');
  assert.equal(oversized.reason, 'oversized');
  assert.equal(oversized.size, 1024);
  assert.equal('content' in oversized, false);

  mkdirSync(join(dir, 'sub'));
  assert.throws(() => readBoundedFile(join(dir, 'sub')), { code: 'ENOTREGULAR' });
});

test('NUL bytes mark binary, UTF-16 text does not', (t) => {
  const dir = fixture(t);
  const binary = join(dir, 'model.pt');
  writeFileSync(binary, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00, 0xff, 0x00, 0x01]));
  const read = readBoundedFile(binary);
  assert.equal(read.state, 'omitted');
  assert.equal(read.reason, 'binary');
  assert.match(describeOmittedFile(read), /NUL bytes/);

  assert.equal(looksBinary(Buffer.from('\ufeffplain text', 'utf16le')), false);
  assert.equal(looksBinary(Buffer.from('BOM-less UTF-16 text that is long enough', 'utf16le')), false);
  assert.equal(looksBinary(Buffer.from('plain utf-8 text')), false);
});

test('binary-ness is decided from the whole bounded content, not a prefix', (t) => {
  const dir = fixture(t);
  // Clean 8 KiB head, NUL bytes on both parities after it.
  const lateBinary = join(dir, 'late-nul.bin');
  const tail = Buffer.alloc(8 * 1024, 0x41);
  for (let index = 0; index < tail.length; index += 3) tail[index] = 0;
  writeFileSync(lateBinary, Buffer.concat([Buffer.alloc(8 * 1024, 0x61), tail]));
  const late = readBoundedFile(lateBinary);
  assert.equal(late.state, 'omitted');
  assert.equal(late.reason, 'binary');

  // 24 KiB BOM-less UTF-16LE: its head alone has a NUL ratio below one half
  // ('ā' has no zero byte), the whole file is UTF-16 by the codec's rule.
  const utf16 = join(dir, 'bomless-utf16.txt');
  const text = 'āāa'.repeat(4096 / 3 + 1).slice(0, 4096) + 'a'.repeat(8192);
  const bytes = Buffer.from(text, 'utf16le');
  assert.equal(bytes.length, 24 * 1024);
  writeFileSync(utf16, bytes);
  const read = readBoundedFile(utf16);
  assert.equal(read.state, 'present');
  assert.equal(read.content.toString('utf16le'), text);
  assert.equal(detectTextCodec(bytes).encoding, 'utf16le');
});

test('a file that grows after fstat is still read no further than maxBytes + 1', (t) => {
  const dir = fixture(t);
  const file = join(dir, 'growing.log');
  const maxBytes = 64 * 1024;
  writeFileSync(file, 'y'.repeat(1024 * 1024));
  // fstat reports the size from before the growth; the bytes on disk are 16x the cap.
  const realFstat = fs.fstatSync;
  const realReadSync = fs.readSync;
  let bytesRead = 0;
  t.mock.method(fs, 'fstatSync', (fd, ...rest) => {
    const stat = realFstat(fd, ...rest);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 10 });
  });
  t.mock.method(fs, 'readSync', (...args) => {
    const read = realReadSync(...args);
    bytesRead += read;
    return read;
  });
  syncBuiltinESMExports();
  let read;
  try {
    read = readBoundedFile(file, { maxBytes });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(read.state, 'omitted');
  assert.equal(read.reason, 'oversized');
  assert.equal(read.size, maxBytes + 1);
  assert.ok(bytesRead <= maxBytes + 1, `read ${bytesRead} bytes past the ${maxBytes}-byte cap`);
});

test('the transaction budget omits files once their sum would exceed it', (t) => {
  const dir = fixture(t);
  const budget = createSnapshotBudget(100);
  const reads = ['a', 'b', 'c'].map((name) => {
    const file = join(dir, `${name}.txt`);
    writeFileSync(file, name.repeat(40));
    return readBoundedFile(file, { budget });
  });
  assert.deepEqual(
    reads.map((read) => read.state),
    ['present', 'present', 'omitted']
  );
  assert.equal(reads[2].reason, 'budget');
  assert.equal(budget.remaining, 20);
  assert.equal(PATCH_SNAPSHOT_MAX_BYTES, 8 * 1024 * 1024);
});
