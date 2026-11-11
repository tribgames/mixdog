// The listing's storage refresh (the daemon's session.list) reads every log
// whose stamp changed, and a session that is being written changes at every
// refresh. A log of 2 MB or more is read as the facts its row is made of, from
// where the last read of it stopped (session-log-reader.mjs), and by the facts
// worker (summary-facts-worker.mjs): the refresh is awaited on the main
// thread, and a log of hundreds of megabytes is assembled and parsed for as
// long as it takes, with the event loop held.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-refresh-facts-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const { listStoredSessionSummariesAsync, settleSessionSummaryIndex } = await import('./listing.mjs');
const { _scanStoredSessionSummaryRowsAsync } = await import('./summary-cache.mjs');
const { drainSessionStore } = await import('../store.mjs');
const { encodeAppend, encodeCompacted, encodePatch, encodeSessionRecord } = await import('./session-log-format.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  drainSessionStore();
  rmSync(root, { recursive: true, force: true });
});

const user = (text) => JSON.stringify({ role: 'user', content: text });
const reply = (text) => JSON.stringify({ role: 'assistant', content: text });

// The longest interval the main thread's event loop did not run while `run` goes.
async function longestBlocked(run) {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);
  try {
    return { value: await run(), longest: Math.max(longest, performance.now() - last) };
  } finally {
    clearInterval(timer);
  }
}

test('a refresh after a log grew builds the rows a whole read builds', async () => {
  const id = 'sess_refresh_grows';
  const logPath = join(root, 'sessions', `${id}.log.jsonl`);
  const filler = 'f'.repeat(512 * 1024);
  let text =
    encodeSessionRecord({ logId: 'L1', id, legacy: null, header: { id, title: 'first', updatedAt: 1000, createdAt: 900 } }) +
    encodeCompacted(1, [user('the first prompt')]);
  for (let i = 0; i < 8; i += 1) text += encodeAppend(2 + i, 2 + i, [i % 2 ? reply(`${filler} ${i}`) : user(`${filler} ${i}`)]);
  writeFileSync(logPath, text);
  const first = await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  assert.equal(first.length, 1);

  appendFileSync(logPath, encodePatch(10, [['title', '"second"']], []) + encodeAppend(11, 10, [reply('the last answer')]));
  const second = await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  assert.equal(second[0].title, 'second');
  assert.equal(second[0].messageCount, 10);
  assert.equal(second[0].preview, 'the first prompt');
  const { rows } = await _scanStoredSessionSummaryRowsAsync();
  assert.deepEqual(second, rows);
  rmSync(logPath);
});

test('a cold refresh of a log with a 100 MB line does not hold the main thread', async () => {
  const id = 'sess_refresh_long_line';
  const logPath = join(root, 'sessions', `${id}.log.jsonl`);
  writeFileSync(
    logPath,
    encodeSessionRecord({ logId: 'L2', id, legacy: null, header: { id, title: 'long', updatedAt: 2000, createdAt: 1900 } }) +
      encodeCompacted(1, [user('x'.repeat(100 * 1024 * 1024))])
  );
  const { value, longest } = await longestBlocked(() => listStoredSessionSummariesAsync({ refreshFromStorage: true }));
  assert.equal(value.find((row) => row.id === id)?.messageCount, 1);
  assert.ok(longest < 250, `the main thread did not run for ${Math.round(longest)} ms`);
});