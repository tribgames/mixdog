// A log is scanned a block at a time, and a line that is longer than a block
// (a compacted history of a long session is one) spans several. Its blocks
// were joined and searched again for the line's end for every block that
// followed, so the work grew with the square of the line's length. A 200 MB
// line is scanned in time linear in its length and holds it once (not its\n// pieces beside their join), whatever the block size.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeAppend, encodeCompacted, encodePatch, encodeSessionRecord } from './session-log-format.mjs';
import { parseSessionLog, readSessionLog, readSessionLogSync } from './session-log-reader.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-long-line-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

// The most buffer memory (process.memoryUsage().arrayBuffers, over what there was
// before) alive at any allocation or join while `run` goes: the moments a line's
// pieces and its join would be alive together.
async function peakBuffers(run) {
  const { concat, allocUnsafe } = Buffer;
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  const sample = () => (peak = Math.max(peak, process.memoryUsage().arrayBuffers - base));
  Buffer.concat = (...args) => {
    const joined = concat.apply(Buffer, args);
    sample();
    return joined;
  };
  Buffer.allocUnsafe = (...args) => {
    const bytes = allocUnsafe.apply(Buffer, args);
    sample();
    return bytes;
  };
  try {
    return { value: await run(), peak };
  } finally {
    Buffer.concat = concat;
    Buffer.allocUnsafe = allocUnsafe;
  }
}

test('a 200 MB single line is scanned in time linear in its length, holding it once', async () => {
  const logPath = join(root, 'sess_long_line.log.jsonl');
  const line = encodeCompacted(1, [JSON.stringify({ role: 'user', content: 'x'.repeat(200 * 1024 * 1024) })]);
  writeFileSync(
    logPath,
    encodeSessionRecord({ logId: 'L1', id: 'sess_long_line', legacy: null, header: { id: 'sess_long_line', title: 'a' } }) + line
  );
  const size = readFileSync(logPath).length;
  assert.ok(size > 200 * 1024 * 1024, `a ${size}-byte log`);

  const started = performance.now();
  const { value, peak } = await peakBuffers(() => readSessionLog(logPath, { messages: false }));
  const ms = performance.now() - started;
  assert.equal(value.messageCount, 1);
  assert.equal(value.header.title, 'a');
  // The line once, and the block being read; its pieces beside their join took 2x.
  assert.ok(peak <= 1.25 * size, `${peak} bytes of buffers alive at once to scan a ${size}-byte log`);
  assert.ok(ms < 30_000, `${Math.round(ms)} ms to scan a ${size}-byte log`);
  // What follows the long line, and a torn tail after it, are read as before.
  appendFileSync(logPath, encodePatch(2, [['title', '"b"']], []) + encodeAppend(3, 2, ['{"role":"user","content":"y"}']));
  appendFileSync(logPath, '{"s":4,"t":"app');
  const sync = readSessionLogSync(logPath, { messages: false });
  assert.deepEqual(sync, parseSessionLog(readFileSync(logPath), { messages: false }));
  assert.equal(sync.header.title, 'b');
  assert.equal(sync.messageCount, 2);
  assert.equal(sync.tornTail.length, 15);
});
