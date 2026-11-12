// A named copy that is already there is validated by a stat (size equal to the
// blob's): neither the copy nor the blob is read again on the submit path.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('named-attachment-reads');
process.env.MIXDOG_DATA_DIR = dataDir;

const reads = [];
mock.module('node:fs', {
  namedExports: {
    ...fs,
    readFileSync: (path, ...rest) => {
      reads.push(String(path));
      return fs.readFileSync(path, ...rest);
    },
  },
});

const { namedAttachmentFile, storeAttachmentBuffer } = await import('./store.mjs');

test('a second call for the same attachment reads neither the named copy nor the blob', () => {
  const bytes = Buffer.from('\xff\xd8\xff\xe0 a lease photo', 'latin1');
  const { attachmentRef } = storeAttachmentBuffer(bytes);
  const options = { filename: 'lease.jpg', mimeType: 'image/jpeg' };
  const path = namedAttachmentFile(attachmentRef, options);
  assert.deepEqual(readFileSync(path), bytes);
  reads.length = 0;
  assert.equal(namedAttachmentFile(attachmentRef, options), path);
  assert.equal(namedAttachmentFile(attachmentRef, { mimeType: 'image/jpeg' }), path, 'unnamed reuse');
  assert.deepEqual(reads, []);
});

test('a copy of the wrong size is rewritten from the blob', () => {
  const bytes = Buffer.from('plain attachment body');
  const { attachmentRef } = storeAttachmentBuffer(bytes);
  const path = namedAttachmentFile(attachmentRef, { filename: 'note.txt', mimeType: 'text/plain' });
  writeFileSync(path, 'torn');
  assert.equal(namedAttachmentFile(attachmentRef, { filename: 'note.txt', mimeType: 'text/plain' }), path);
  assert.deepEqual(readFileSync(path), bytes);
});

test('a readable original whose copy cannot be written throws instead of handing on the model copy', () => {
  const full = storeAttachmentBuffer(Buffer.from('FULL ORIGINAL CONTENT'));
  const resized = storeAttachmentBuffer(Buffer.from('MODEL RESIZED'));
  const options = { filename: 'scan.png', mimeType: 'image/png' };
  const probe = namedAttachmentFile(full.attachmentRef, options);
  fs.rmSync(dirname(probe), { recursive: true, force: true });
  mkdirSync(probe, { recursive: true });
  assert.throws(() =>
    namedAttachmentFile(resized.attachmentRef, {
      ...options,
      original: { attachmentRef: full.attachmentRef, mimeType: 'image/png' },
    })
  );
});
