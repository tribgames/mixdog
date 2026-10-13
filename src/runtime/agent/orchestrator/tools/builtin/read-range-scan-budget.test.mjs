import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-range-scan-budget-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { streamReadRange } = await import('./read-streaming.mjs');
const { READ_MAX_SCAN_BYTES } = await import('./read-constants.mjs');
let sequence = 0;
test.after(() => fs.rm(root, { recursive: true, force: true }));

// Exercise the real scanner and its real byte limit without a 512 MiB fixture.
// The virtual file is zero-filled except for an explicitly positioned suffix.
async function fixture(t, size, suffixPosition, suffix) {
  const path = join(root, `${sequence++}.txt`);
  await fs.writeFile(path, '');
  const st = await fs.stat(path);
  st.size = size;
  const bytes = Buffer.from(suffix);
  assert.ok(suffixPosition + bytes.length <= size);
  const reads = [];
  let closes = 0;
  const open = fs.open;
  const stat = fs.stat;
  t.mock.method(fs, 'stat', (file, ...args) => file === path ? Promise.resolve(st) : stat(file, ...args));
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === path) {
      t.mock.method(handle, 'stat', async () => st);
      t.mock.method(handle, 'read', async (buffer, offset, length, position) => {
        const bytesRead = Math.min(length, Math.max(0, size - position));
        buffer.fill(0, offset, offset + bytesRead);
        const start = Math.max(position, suffixPosition);
        const end = Math.min(position + bytesRead, suffixPosition + bytes.length);
        if (end > start) bytes.copy(buffer, offset + start - position, start - suffixPosition, end - suffixPosition);
        reads.push({ position, length, bytesRead });
        return { buffer, bytesRead };
      });
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        closes++;
        await close();
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { path, st, reads, closes: () => closes };
}

test('a complete requested line below the scan cap survives an adaptive chunk crossing the cap', async (t) => {
  const f = await fixture(t, READ_MAX_SCAN_BYTES + 65536, READ_MAX_SCAN_BYTES - 65521, '\nTARGET\n');
  const result = await streamReadRange(f.path, 1, 1, f.st);
  assert.equal(result.text.split('\n')[0], '2→TARGET');
  assert.equal(result.firstEmitted, 2);
  assert.equal(result.lastEmitted, 2);
  assert.ok(f.reads.every(({ position, bytesRead }) => position + bytesRead <= READ_MAX_SCAN_BYTES));
  assert.equal(f.closes(), 1);
});

test('a requested line ending exactly at the scan cap needs no read beyond the cap', async (t) => {
  const suffix = '\nTARGET\n';
  const f = await fixture(t, READ_MAX_SCAN_BYTES + 1, READ_MAX_SCAN_BYTES - suffix.length, suffix);
  const result = await streamReadRange(f.path, 1, 1, f.st);
  assert.equal(result.text.split('\n')[0], '2→TARGET');
  assert.equal(f.reads.at(-1).position + f.reads.at(-1).bytesRead, READ_MAX_SCAN_BYTES);
  assert.equal(f.closes(), 1);
});

test('an unterminated requested line at exact EOF on the scan cap is complete', async (t) => {
  const suffix = '\nTARGET';
  const f = await fixture(t, READ_MAX_SCAN_BYTES, READ_MAX_SCAN_BYTES - suffix.length, suffix);
  const result = await streamReadRange(f.path, 1, 1, f.st);
  assert.equal(result.text.split('\n')[0], '2→TARGET');
  assert.deepEqual(f.reads.at(-1), { position: READ_MAX_SCAN_BYTES, length: 1, bytesRead: 0 });
  assert.equal(f.closes(), 1);
});

test('a line continuing beyond the scan cap is rejected rather than delivered as a complete tail', async (t) => {
  const f = await fixture(t, READ_MAX_SCAN_BYTES + 1, READ_MAX_SCAN_BYTES - 7, '\nTARGETX');
  await assert.rejects(streamReadRange(f.path, 1, 1, f.st), {
    message: `read scan exceeds ${READ_MAX_SCAN_BYTES} bytes`,
  });
  assert.deepEqual(f.reads.at(-1), { position: READ_MAX_SCAN_BYTES, length: 1, bytesRead: 1 });
  assert.equal(f.closes(), 1);
});

test('a requested line starting beyond the scan cap remains inaccessible', async (t) => {
  const f = await fixture(t, READ_MAX_SCAN_BYTES + 8, READ_MAX_SCAN_BYTES, '\nTARGET\n');
  await assert.rejects(streamReadRange(f.path, 1, 1, f.st), {
    message: `read scan exceeds ${READ_MAX_SCAN_BYTES} bytes`,
  });
  assert.deepEqual(f.reads.at(-1), { position: READ_MAX_SCAN_BYTES, length: 1, bytesRead: 1 });
  assert.equal(f.closes(), 1);
});
