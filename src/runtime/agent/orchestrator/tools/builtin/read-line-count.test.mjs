import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-line-count-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { flushReadRangeIndexesSync } = await import('./read-range-index.mjs');
const { countLogicalLinesBytesSync } = await import('./read-streaming.mjs');

after(async () => {
  flushReadRangeIndexesSync();
  await fs.rm(root, { recursive: true, force: true });
});

// The fixture must exceed the 128 KB streaming threshold: that is the size at
// which `read mode:tail` (exact line numbers) and `mode:count`/`mode:summary`
// route through this counter, which records a byte anchor at every newline it
// passes. Smaller fixtures never reach it.
test('line counting a file past the streaming threshold returns the exact count', async () => {
  const line = `${'x'.repeat(63)}\n`;
  const expected = 4000;
  const file = join(root, 'large.txt');
  await fs.writeFile(file, line.repeat(expected));
  const st = await fs.stat(file);
  assert.ok(st.size > 128 * 1024, `fixture must exceed the streaming threshold (got ${st.size} bytes)`);

  assert.equal(await countLogicalLinesBytesSync(file, st.size, st), expected);
});
