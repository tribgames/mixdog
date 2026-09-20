// Characterization of the cycle scheduler's run machinery: cycle1 coalescing
// + caller deadline, health ledger / state file, cycle2 scheduled catch-up
// drain with retry cap, backlog probe + raw-embed flush, and start/stop.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCycleScheduler } from './cycle-scheduler.mjs';
import { sleep } from '../../shared/sleep.mjs';

function makeHarness(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cycle-runs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const record = (...entry) => calls.push(entry);
  const h = {
    calls,
    record,
    named: (name) => calls.filter((entry) => entry[0] === name),
    logs: [],
    lastRun: {},
    counts: [],
    cycleStateFile: join(dir, 'state.json'),
    readState: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    retryTasks: [],
    runCycle1: async () => ({ processed: 1, chunks: 1, skipped: 0, sessions: 1 }),
    runCycle2: async () => ({ ok: true, processed: 1 }),
  };
  const db = {
    query: async (sql, params) => {
      record('query', sql.replace(/\s+/g, ' ').trim().slice(0, 60), params);
      return { rows: [{ c: h.counts.length ? h.counts.shift() : 0 }] };
    },
  };
  h.scheduler = createCycleScheduler({
    getDb: () => db,
    getConfig: () => h.config ?? {},
    setConfig: (next) => record('setConfig', next),
    dataDir: dir,
    log: (line) => h.logs.push(line),
    getCycleLastRun: async () => h.lastRun,
    setCycleLastRun: async (key, value) => record('setCycleLastRun', key, value),
    readMainConfig: () => h.config ?? {},
    memoryCyclesEnabled: () => true,
    getCycle1CallLlm: () => 'llm1',
    getCycle2CallLlm: () => 'llm2',
    runCycle1: (...args) => {
      record('runCycle1', args[1], args[2]);
      return h.runCycle1(...args);
    },
    runCycle2: (...args) => {
      record('runCycle2', args[1], args[2]);
      return h.runCycle2(...args);
    },
    parseInterval: () => 60_000,
    flushRawEmbeddings: async () => {
      record('flushRawEmbeddings');
      return { attempted: 2, embedded: 1 };
    },
    claimAndMarkScheduledCycle: async () => ({ claimed: false }),
    resolveCoalesceMaxRetries: () => 1,
    scheduleCoalescedCycleRetry: (_db, kind, task, config, signature) => {
      record('retry', kind, signature);
      h.retryTasks.push({ kind, task, config, signature });
    },
    cancelCoalescedCycleRetries: () => record('cancelRetries'),
    scheduledCycle1Signature: () => 'sig1',
    scheduledCycle2Signature: () => 'sig2',
    cycleStateFile: h.cycleStateFile,
    ...overrides,
  });
  return h;
}

test('startCycle1Run injects the LLM adapter, marks running, records heartbeat + last run, and coalesces awaiters', async (t) => {
  const h = makeHarness(t);
  let release;
  h.runCycle1 = () =>
    new Promise((resolve) => {
      release = () => resolve({ processed: 2, chunks: 1, skipped: 0, sessions: 1 });
    });
  const first = h.scheduler.startCycle1Run({ batch_size: 5 });
  assert.equal(h.scheduler.getCycle1InFlight(), first);
  assert.deepEqual(h.scheduler.getCycleRunning().cycle, 'cycle1');
  assert.equal(h.readState().running.cycle, 'cycle1');
  assert.equal(h.readState().running.pid, process.pid);
  assert.deepEqual(h.named('runCycle1')[0][1], { batch_size: 5 });
  assert.equal(h.named('runCycle1')[0][2].callLlm, 'llm1');

  const second = h.scheduler.awaitCycle1Run({ ignored: true });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, 'a concurrent awaiter shares the in-flight run');
  assert.equal(h.named('runCycle1').length, 1);
  assert.deepEqual(
    h.named('setCycleLastRun').map((entry) => entry[1]),
    ['cycle1_heartbeat', 'cycle1']
  );
  assert.equal(h.scheduler.getCycle1InFlight(), null);
  assert.equal(h.scheduler.getCycleRunning(), null);
  assert.equal(h.readState().running, null);
  const health = h.scheduler.getCycleHealth().cycle1;
  assert.ok(health.last_success_at > 0);
  assert.equal(health.consecutive_failures, 0);
});

test('awaitCycle1Run returns a skipped marker when the caller deadline elapses first', async (t) => {
  const h = makeHarness(t);
  h.runCycle1 = async () => {
    await sleep(80);
    return { processed: 1, chunks: 1, skipped: 0, sessions: 1 };
  };
  const result = await h.scheduler.awaitCycle1Run({}, { callerDeadlineMs: 10 });
  assert.deepEqual(result, {
    processed: 0,
    chunks: 0,
    skipped: 0,
    sessions: 0,
    skippedInFlight: true,
    timedOutWaiting: true,
    callerDeadlineMs: 10,
  });
  await h.scheduler.getCycle1InFlight();
});

test('an all-skipped cycle1 keeps the heartbeat but not the last run and counts as a failure; errors warn after 5', async (t) => {
  const h = makeHarness(t);
  h.runCycle1 = async () => ({ processed: 0, chunks: 0, skipped: 3, sessions: 1 });
  await h.scheduler.startCycle1Run();
  assert.deepEqual(
    h.named('setCycleLastRun').map((entry) => entry[1]),
    ['cycle1_heartbeat']
  );
  assert.equal(h.scheduler.getCycleHealth().cycle1.last_error, 'all rows skipped');
  assert.equal(h.scheduler.getCycleHealth().cycle1.consecutive_failures, 1);

  h.runCycle1 = async () => {
    throw new Error('llm down');
  };
  for (let i = 0; i < 4; i++) await assert.rejects(h.scheduler.startCycle1Run(), /llm down/);
  assert.equal(h.scheduler.getCycleHealth().cycle1.consecutive_failures, 5);
  assert.equal(h.scheduler.getCycleHealth().cycle1.last_error, 'llm down');
  const warns = h.logs.filter((line) => line.includes('[cycle-health] WARN'));
  assert.equal(warns.length, 1, 'repeated-failure warning is emitted once per cooldown');
  assert.match(warns[0], /cycle1 failing repeatedly \(consecutive=5/);
  assert.equal(h.readState().cycles.cycle1.consecutive_failures, 5);
});

test('a skipped-in-flight scheduled cycle1 re-arms the coalesced retry up to the cap', async (t) => {
  const h = makeHarness(t, { claimAndMarkScheduledCycle: async () => ({ claimed: true }) });
  h.runCycle1 = async () => ({ skippedInFlight: true });
  await h.scheduler.checkCycles();
  assert.deepEqual(
    h.retryTasks.map((entry) => entry.kind),
    ['cycle1', 'cycle2']
  );
  await h.retryTasks[0].task();
  assert.equal(h.retryTasks.length, 3, 'attempt 1 re-armed');
  await h.retryTasks[2].task();
  assert.equal(h.retryTasks.length, 3, 'attempt 2 exceeds maxRetries=1');
  assert.ok(h.logs.includes('[cycle1] scheduled queue retry cap reached\n'));
  assert.deepEqual(h.named('runCycle1')[0][1], {
    min_batch: 20,
    session_cap: 4,
    batch_size: 50,
    max_packets: 4,
    concurrency: 4,
  });
  assert.equal(h.named('runCycle1')[0][2].coalescedRetry, true);
  assert.equal(typeof h.named('runCycle1')[0][2].onCoalescedSuccess, 'function');
});

test('the scheduled cycle2 task drains catch-up passes while roots remain and finalizes success', async (t) => {
  const h = makeHarness(t, { claimAndMarkScheduledCycle: async () => ({ claimed: true }) });
  h.config = { cycle2: { catchup_passes: 3 } };
  h.runCycle2 = async (_db, _config, options) => {
    const result = { ok: true, processed: 4 };
    await options.onCoalescedSuccess(result);
    return result;
  };
  await h.scheduler.checkCycles();
  h.calls.length = 0;
  h.counts.push(7, 0);
  await h.retryTasks[1].task();
  const runs = h.named('runCycle2');
  assert.equal(runs.length, 2, 'stops once no pending roots remain');
  assert.deepEqual(
    runs.map((entry) => entry[2].catchUpDrainPass),
    [false, true]
  );
  assert.equal(runs[0][2].callLlm, 'llm2');
  assert.equal(runs[0][2].coalescedRetry, true);
  assert.deepEqual(
    h.named('setCycleLastRun').map((entry) => [entry[1], entry[2] === '' ? '' : typeof entry[2]]),
    [
      ['cycle2', 'number'],
      ['cycle2_last_error', ''],
      ['cycle2', 'number'],
      ['cycle2_last_error', ''],
    ]
  );
  assert.ok(h.logs.includes('[cycle2] catch-up pass 1/3: processed=4 pending=7\n'));
  assert.ok(h.logs.includes('[cycle2] catch-up pass 2/3: processed=4 pending=0\n'));
  assert.equal(h.scheduler.getCycleHealth().cycle2.consecutive_failures, 0);
  assert.equal(h.scheduler.getCycleRunning(), null);
  assert.equal(h.readState().running, null);
});

test('a failed scheduled cycle2 pass finalizes the error once and stops draining; a thrown pass marks failure', async (t) => {
  const h = makeHarness(t, { claimAndMarkScheduledCycle: async () => ({ claimed: true }) });
  h.runCycle2 = async () => ({ ok: false, error: 'review failed' });
  await h.scheduler.checkCycles();
  h.calls.length = 0;
  await h.retryTasks[1].task();
  assert.equal(h.named('runCycle2').length, 1);
  assert.deepEqual(
    h.named('setCycleLastRun').map((entry) => [entry[1], entry[2]]),
    [['cycle2_last_error', 'review failed']]
  );
  assert.equal(h.scheduler.getCycleHealth().cycle2.last_error, 'review failed');
  assert.ok(h.logs.includes('[cycle2] failed: review failed\n'));

  h.runCycle2 = async () => {
    throw new Error('db gone');
  };
  await h.retryTasks[1].task();
  assert.equal(h.scheduler.getCycleHealth().cycle2.consecutive_failures, 2);
  assert.ok(h.logs.includes('[cycle2] scheduled queue failed: db gone\n'));
  assert.equal(h.scheduler.getCycleRunning(), null);
});

test('checkCycles snapshots the backlog, flushes raw embeddings once while in flight, and warns above the threshold', async (t) => {
  const h = makeHarness(t);
  h.counts.push(600, 10, 501);
  await h.scheduler.checkCycles();
  assert.deepEqual(h.named('setConfig').length, 1);
  const snapshot = h.scheduler.getCycleBacklogSnapshot();
  assert.deepEqual(
    {
      unchunked: snapshot.unchunked,
      unchunked_eligible: snapshot.unchunked_eligible,
      cycle2_pending: snapshot.cycle2_pending,
    },
    { unchunked: 600, unchunked_eligible: 10, cycle2_pending: 501 }
  );
  assert.deepEqual(h.readState().backlog, snapshot);
  assert.equal(h.named('flushRawEmbeddings').length, 1);
  assert.ok(h.logs.some((line) => line.includes('backlog unchunked=600 eligible=10 cycle2_pending=501')));
  await sleep(0);
  assert.ok(h.logs.includes('[embed] raw fallback flush attempted=2 embedded=1\n'));
});

test('startCycles clears a stale running marker, hydrates health from the last-run meta, and stopCycles cancels retries', async (t) => {
  const h = makeHarness(t);
  h.lastRun = { cycle1: 111, cycle2: 222 };
  h.scheduler.startCycles();
  h.scheduler.startCycles();
  assert.equal(h.readState().running, null);
  await sleep(0);
  assert.equal(h.scheduler.getCycleHealth().cycle1.last_success_at, 111);
  assert.equal(h.scheduler.getCycleHealth().cycle2.last_success_at, 222);
  assert.equal(h.readState().cycles.cycle2.last_success_at, 222);
  h.scheduler.stopCycles();
  assert.deepEqual(h.named('cancelRetries'), [['cancelRetries']]);
  h.scheduler.resetInFlight();
  assert.equal(h.scheduler.getCycle1InFlight(), null);
  assert.equal(h.scheduler.getCycleRunning(), null);
});
