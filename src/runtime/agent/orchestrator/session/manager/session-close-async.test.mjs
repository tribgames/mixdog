// closeSessionAsync waits out a rename the OS refuses (Windows EPERM/EBUSY
// while a scanner holds the file) on timers: the event loop keeps ticking
// through the whole retry schedule, the barrier still lands, and a rename that
// never succeeds ends with the rename's own error, exactly as the synchronous
// barrier would.
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-close-async-'));
process.env.MIXDOG_DATA_DIR = root;

const { closeSessionAsync } = await import('./session-close.mjs');
const { saveSessionAsync, getSessionLifecycleCommitError } = await import('../store.mjs');
const { sessionPath } = await import('../store/session-paths.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');
const { flushSessionCloseMetrics } = await import('../store/lifecycle-barriers.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  await flushSessionCloseMetrics();
  rmSync(root, { recursive: true, force: true });
});

const session = (id) => ({
  id,
  owner: 'agent',
  agent: 'worker',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [{ role: 'user', content: 'hello' }],
});

/** renameSync onto `target` refused with `code` for the first `times` calls. */
function refuseRenames(t, target, code, times) {
  const original = fs.renameSync;
  const state = { refused: 0 };
  fs.renameSync = function (from, to, ...rest) {
    if (String(to) === target && state.refused < times) {
      state.refused++;
      const err = new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`);
      err.code = code;
      throw err;
    }
    return original.call(this, from, to, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = original;
    syncBuiltinESMExports();
  });
  return state;
}

// Worst tick gap measured for the retries themselves is ~40 ms; the runner
// adds scheduling noise on top (168 ms seen). The synchronous barrier freezes
// the loop for the whole retry delay sum, so the limits sit between the two:
// four refusals sleep >= 375 ms, the full schedule ~4.2 s.
const FOUR_REFUSALS_GAP_LIMIT_MS = 300;
const EXHAUSTED_GAP_LIMIT_MS = 2000;

/** Largest gap between 5 ms ticks while `run` settles. */
async function maxLoopGap(run) {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    const value = await run();
    return { value, max };
  } finally {
    clearInterval(timer);
  }
}

for (const [code, tombstone] of [
  ['EPERM', false],
  ['EBUSY', true],
]) {
  test(`a ${code}-refused barrier rename retries without blocking the loop (tombstone=${tombstone})`, async (t) => {
    const id = `sess_close_async_${code.toLowerCase()}`;
    await saveSessionAsync(session(id));
    const before = JSON.parse(readFileSync(sessionPath(id), 'utf8')).generation;
    // Four refusals: 25 + 50 + 100 + 200 ms of backoff (plus jitter) — a
    // ~400 ms freeze for the synchronous barrier.
    const refused = refuseRenames(t, sessionPath(id), code, 4);
    const { value, max } = await maxLoopGap(() => closeSessionAsync(id, 'cli-agent-close', { tombstone }));
    assert.equal(value, true);
    assert.equal(refused.refused, 4);
    assert.ok(max < FOUR_REFUSALS_GAP_LIMIT_MS, `event loop gap ${Math.round(max)}ms during the retries`);
    const disk = JSON.parse(readFileSync(sessionPath(id), 'utf8'));
    assert.equal(disk.generation, before + 1, 'the generation bump landed');
    assert.equal(disk.closed, tombstone);
    assert.equal(getSessionLifecycleCommitError(id), null);
  });
}

test('a rename refused through the whole schedule fails the close with the rename error', async (t) => {
  const id = 'sess_close_async_exhausted';
  await saveSessionAsync(session(id));
  const before = readFileSync(sessionPath(id), 'utf8');
  const refused = refuseRenames(t, sessionPath(id), 'EPERM', Infinity);
  const { value, max } = await maxLoopGap(() => closeSessionAsync(id, 'cli-agent-close', { tombstone: false }));
  assert.equal(value, false);
  // DEFAULT_BACKOFFS_MS has 23 delays: 24 attempts, as renameWithRetrySync makes.
  assert.equal(refused.refused, 24);
  assert.ok(max < EXHAUSTED_GAP_LIMIT_MS, `event loop gap ${Math.round(max)}ms during the retries`);
  assert.equal(getSessionLifecycleCommitError(id)?.code, 'EPERM');
  assert.equal(readFileSync(sessionPath(id), 'utf8'), before, 'the canonical record is untouched');
});
