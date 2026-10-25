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
  const state = { refused: 0, ticksAtRefusal: [] };
  fs.renameSync = function (from, to, ...rest) {
    if (String(to) === target && state.refused < times) {
      state.refused++;
      state.ticksAtRefusal.push(loopTicks);
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

// The synchronous barrier would retry in one blocked turn; the async one waits
// on timers, so the loop's own timer fires between any two refusals. Counted
// ticks replace a wall-clock gap limit.
let loopTicks = 0;

/** Runs `run` while counting 1 ms loop ticks; the value comes back with them. */
async function withLoopTicks(run) {
  const timer = setInterval(() => {
    loopTicks += 1;
  }, 1);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

const tickedBetween = (ticksAtRefusal) => ticksAtRefusal.every((ticks, i) => i === 0 || ticks > ticksAtRefusal[i - 1]);

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
    const value = await withLoopTicks(() => closeSessionAsync(id, 'cli-agent-close', { tombstone }));
    assert.equal(value, true);
    assert.equal(refused.refused, 4);
    assert.ok(tickedBetween(refused.ticksAtRefusal), 'the loop ticked between retries');
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
  const value = await withLoopTicks(() => closeSessionAsync(id, 'cli-agent-close', { tombstone: false }));
  assert.equal(value, false);
  // DEFAULT_BACKOFFS_MS has 23 delays: 24 attempts, as renameWithRetrySync makes.
  assert.equal(refused.refused, 24);
  assert.ok(tickedBetween(refused.ticksAtRefusal), 'the loop ticked between retries');
  assert.equal(getSessionLifecycleCommitError(id)?.code, 'EPERM');
  assert.equal(readFileSync(sessionPath(id), 'utf8'), before, 'the canonical record is untouched');
});
