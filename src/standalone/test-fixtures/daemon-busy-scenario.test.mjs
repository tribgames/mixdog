// Turn timing of the busy scenario keeps the stalls it exists to catch: a
// liveness read that comes back after a long stall must not end the wait, and a
// turn the window cuts is censored (reported with its elapsed time), not failed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { latency, newBucket, runBusyScenario, sample, waitForTurnDone } from './daemon-busy-scenario.mjs';

const TOKEN = 'BENCH-TURN-0-1';
const view = (turnEnded) => ({
  full: {
    items: [
      { kind: 'user', text: `continue the work ${TOKEN}` },
      ...(turnEnded ? [{ kind: 'turndone', status: 'done' }] : []),
    ],
  },
});

/** A client and a clock under test control: each call may advance the clock. */
function scripted(replies) {
  const clock = { t: 0 };
  const log = [];
  return {
    clock,
    log,
    now: () => clock.t,
    pause: async (ms) => {
      clock.t += ms;
    },
    client: {
      async call(name, args) {
        const kind = args.action === 'getTurnLiveness' ? 'liveness' : 'transcript';
        log.push(kind);
        const reply = replies.shift();
        clock.t += reply.takes;
        return reply.value;
      },
    },
  };
}

test('a liveness read that returns after a 45 s stall does not end the wait', async () => {
  const run = scripted([
    { takes: 45_000, value: { value: { stage: 'streaming' } } }, // stalled read, turn still active
    { takes: 5, value: { value: null } }, // turn over
    { takes: 5, value: view(true) }, // transcript: turndone
  ]);
  const result = await waitForTurnDone({
    client: run.client,
    sessionId: 's',
    token: TOKEN,
    startedAt: 0,
    windowEnd: 600_000,
    now: run.now,
    pause: run.pause,
  });
  assert.equal(result.outcome, 'done');
  assert.ok(result.ms >= 45_000, `the 45 s stall is in the sample (${result.ms} ms)`);
  assert.deepEqual(run.log, ['liveness', 'liveness', 'transcript']);
});

test('a turn still running when the window ends is censored with its elapsed time', async () => {
  const run = scripted([
    { takes: 45_000, value: { value: { stage: 'streaming' } } },
    { takes: 45_000, value: { value: { stage: 'streaming' } } },
  ]);
  const result = await waitForTurnDone({
    client: run.client,
    sessionId: 's',
    token: TOKEN,
    startedAt: 1_000,
    windowEnd: 50_000,
    now: run.now,
    pause: run.pause,
  });
  // Observed when the second late read returned (t = 90.04 s), not cut at the window.
  assert.deepEqual(result, { outcome: 'censored', ms: 89_040, windowBoundedMs: 49_000 });
});

test('a stall that spans the window end is reported as observed, not as the window-bounded time', async () => {
  // The turn starts 100 ms before the window ends; one read then stalls 45 s.
  const run = scripted([{ takes: 45_000, value: { value: { stage: 'streaming' } } }]);
  run.clock.t = 49_900;
  const result = await waitForTurnDone({
    client: run.client,
    sessionId: 's',
    token: TOKEN,
    startedAt: 49_900,
    windowEnd: 50_000,
    now: run.now,
    pause: run.pause,
  });
  assert.equal(result.outcome, 'censored');
  assert.ok(result.ms >= 45_000, `the 45 s of waiting is in the sample (${result.ms} ms)`);
  assert.equal(result.windowBoundedMs, 100, 'the window-bounded figure is separate');
});

test('something that starts after the window is counted apart and never has a negative bounded time', () => {
  const bucket = newBucket();
  bucket.windowEnd = 1_000;
  // The reviewer's probe: a follow-up starting 44,001.4 ms after the window end.
  sample(bucket, 45_001.4, 46_000);
  // An ordinary spanning sample.
  sample(bucket, 900, 5_000);
  const out = latency(bucket);
  assert.deepEqual(out.startedAfterWindow, { count: 1, observedMs: [998.6] });
  assert.equal(out.completed, 1, 'only the sample that started in the window is a window sample');
  assert.deepEqual(out.spanningWindowEnd, { count: 1, observedMs: [4100], windowBoundedMs: [100] });
  assert.ok(out.spanningWindowEnd.windowBoundedMs.every((ms) => ms >= 0));
});

test('a turn wait that begins after the window end reports a zero, not negative, bounded time', async () => {
  const run = scripted([{ takes: 5, value: { value: { stage: 'streaming' } } }]);
  run.clock.t = 2_000;
  const result = await waitForTurnDone({
    client: run.client,
    sessionId: 's',
    token: TOKEN,
    startedAt: 2_000,
    windowEnd: 1_000,
    now: run.now,
    pause: run.pause,
  });
  assert.equal(result.outcome, 'censored');
  assert.equal(result.windowBoundedMs, 0);
});

test('a worktree request is not chained after a create that finished past the window end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'busy-chain-'));
  const calls = [];
  const client = {
    async call(name, args) {
      calls.push(`${name}${args?.action ? `:${args.action}` : ''}`);
      if (name === 'session.create' && args.cwd === dir) {
        await delay(700); // longer than the 300 ms window
        return { sessionId: 'sess_ws' };
      }
      return { sessions: [], value: null };
    },
  };
  const daemon = {
    root: dir,
    dataDir: dir,
    daemonLog: () => '',
    openSessions: async (count) => Array.from({ length: count }, (_, index) => `ctl_${index}`),
    sessionClient: () => client,
    attach: async () => client,
    window: {
      start: async () => ({}),
      stop: async () => ({ cpuPercent: 1, gapTicker: {}, storageTouches: {}, atomicsWaits: [] }),
      close() {},
    },
  };
  try {
    const run = await runBusyScenario({
      daemon,
      treeRoot: fileURLToPath(new URL('../../../', import.meta.url)),
      seeded: { busy: [] },
      repoDir: dir,
      summarize: () => ({}),
      config: {
        seed: 1,
        durationMs: 300,
        saveIntervalMs: 1e6,
        listIntervalMs: 1e6,
        workspaceIntervalMs: 1e6,
        createIntervalMs: 1e6,
        worktreeIntervalMs: 10,
        turnIntervalMs: 0,
        agentIntervalMs: 1e6,
        lockHoldMs: 10,
        lockEveryMs: 1e6,
        listRefresh: false,
      },
    });
    assert.equal(calls.includes('session.configure:requestWorktree'), false, 'the follow-up never started');
    assert.equal(run.operations.requestWorktree.completed, 0);
    assert.equal(run.operations.requestWorktree.startedAfterWindow, undefined);
    assert.equal(run.operations.workspaceSessionCreate.completed, 1);
    assert.ok(run.operations.workspaceSessionCreate.spanningWindowEnd.observedMs[0] >= 600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an abort ends the wait as cancelled, not as a sample', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await waitForTurnDone({
    client: { call: () => assert.fail('no read after an abort') },
    sessionId: 's',
    token: TOKEN,
    startedAt: 0,
    windowEnd: 10,
    signal: controller.signal,
  });
  assert.equal(result.outcome, 'cancelled');
});
