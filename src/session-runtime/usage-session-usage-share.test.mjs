import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageStatsApi } from './usage-stats-api.mjs';

const bucket = (turns) => ({
  turns,
  input: turns,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  unmeasuredTurns: 0,
  costUsd: 0,
  costKnownTurns: turns,
  speedMs: 0,
  speedOutput: 0,
});

/** A ledger whose worker requests wait for the test; it records how many reads (settleWrites to the end) overlap. */
function gatedLedger() {
  const calls = { reads: 0, usage: 0 };
  const gates = [];
  let running = 0;
  const ledger = {
    calls,
    gates,
    mostReading: 0,
    settleWrites: async () => {
      calls.reads += 1;
    },
    sessionUsageAsync: (ids) => {
      calls.usage += 1;
      return new Promise((resolve) => gates.push(() => resolve(bucket(ids.length))));
    },
  };
  return ledger;
}

let currentSession = 'lead';
const apiFor = (ledger) =>
  createUsageStatsApi({
    ledger: () => ledger,
    accountPool: () => ({ accounts: [] }),
    getSessionId: () => currentSession,
  });

const settle = () => new Promise(setImmediate);
async function release(ledger) {
  while (ledger.gates.length) {
    ledger.gates.shift()();
    await settle();
  }
}

test('identical concurrent getSessionUsage calls share one ledger read', async () => {
  currentSession = 'lead';
  const ledger = gatedLedger();
  const api = apiFor(ledger);
  const first = api.getSessionUsage({ sessionIds: ['a', 'b'], agents: true });
  const second = api.getSessionUsage({ sessionIds: ['a', 'b'], agents: true });
  await settle();
  assert.equal(ledger.calls.reads, 1);
  await release(ledger);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  // lead + agents total + one request per named agent
  assert.equal(ledger.calls.usage, 4);
  assert.deepEqual(Object.keys(one.sessions), ['a', 'b']);
});

test('a session runs one read at a time: a different call waits for the running one', async () => {
  currentSession = 'lead';
  const ledger = gatedLedger();
  const api = apiFor(ledger);
  // The island's call and /context's, different options, issued together.
  const island = api.getSessionUsage({ sessionIds: ['a'], agents: true });
  const context = api.getSessionUsage();
  const other = api.getSessionUsage({ sessionIds: ['b'] });
  await settle();
  assert.equal(ledger.calls.reads, 1, 'only the first read has started');
  let ended = 0;
  for (const read of [island, context, other]) read.then(() => (ended += 1));
  // Open one worker request at a time: a read never starts before the previous one ended.
  while (ended < 3) {
    assert.ok(ledger.calls.reads <= ended + 1, `reads ${ledger.calls.reads} started with ${ended} ended`);
    ledger.gates.shift()?.();
    await settle();
  }
  const answers = await Promise.all([island, context, other]);
  assert.equal(ledger.calls.reads, 3);
  assert.deepEqual(Object.keys(answers[0].sessions), ['a']);
  assert.equal(answers[1].sessions, undefined);
  assert.deepEqual(Object.keys(answers[2].sessions), ['b']);
});

test('identical calls that wait behind a running read share one follow-up read', async () => {
  currentSession = 'lead';
  const ledger = gatedLedger();
  const api = apiFor(ledger);
  const running = api.getSessionUsage();
  await settle();
  // A burst of cues while the read runs.
  const burst = Array.from({ length: 5 }, () => api.getSessionUsage({ sessionIds: ['a'], agents: true }));
  await settle();
  assert.equal(ledger.calls.reads, 1);
  for (let step = 0; step < 6; step += 1) await release(ledger);
  await Promise.all([running, ...burst]);
  assert.equal(ledger.calls.reads, 2, 'the burst cost one follow-up read');
  assert.equal(new Set(await Promise.all(burst)).size, 1);
});

test('reads of different sessions do not wait for each other', async () => {
  const ledger = gatedLedger();
  const api = apiFor(ledger);
  currentSession = 'lead-1';
  const first = api.getSessionUsage();
  currentSession = 'lead-2';
  const second = api.getSessionUsage();
  await settle();
  assert.equal(ledger.calls.reads, 2);
  await release(ledger);
  await Promise.all([first, second]);
});

test('a failing named session never lets the next read start while its siblings are outstanding', async () => {
  currentSession = 'lead';
  const gates = new Map();
  let reads = 0;
  let siblingsOutstanding = 0;
  let overlapped = false;
  const ledger = {
    settleWrites: async () => {
      reads += 1;
      if (siblingsOutstanding > 0) overlapped = true;
    },
    sessionUsageAsync: (ids) => {
      if (ids.includes('bad')) return Promise.reject(new Error('worker down'));
      if (!ids.includes('slow')) return Promise.resolve(bucket(1));
      siblingsOutstanding += 1;
      return new Promise((resolve) =>
        gates.set('slow', () => {
          siblingsOutstanding -= 1;
          resolve(bucket(1));
        })
      );
    },
  };
  const api = apiFor(ledger);
  const failing = api.getSessionUsage({ sessionIds: ['bad', 'slow'] });
  const next = api.getSessionUsage({});
  const rejected = assert.rejects(failing, /worker down/);
  await settle();
  assert.equal(reads, 1, 'the next read waits while a sibling request is still out');
  gates.get('slow')();
  await rejected;
  await next;
  assert.equal(reads, 2);
  assert.equal(overlapped, false);
});

test('a failed read frees the session for the next one', async () => {
  currentSession = 'lead';
  let fail = true;
  const ledger = {
    settleWrites: async () => {},
    sessionUsageAsync: async () => {
      if (fail) throw new Error('worker down');
      return bucket(1);
    },
  };
  const api = apiFor(ledger);
  await assert.rejects(Promise.all([api.getSessionUsage({}), api.getSessionUsage({})]), /worker down/);
  fail = false;
  assert.equal((await api.getSessionUsage({})).turns, 1);
});
