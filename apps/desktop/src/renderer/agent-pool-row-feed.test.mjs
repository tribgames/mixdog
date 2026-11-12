// Per-row notifications against today's whole-list path as the oracle: the
// renderer pool store (cancellation ledger, keepRunOrigin, sharePoolRows) must
// end every change exactly where whole-list pushes would have put it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { DesktopStateBridge } from '../main/ipc-state-bridge.ts';
import { agentPoolStore, startAgentPool } from './agent-activity-model.ts';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Main's bridge fed by a fake daemon, and renderer stores on both paths. */
function harness(initial, { wrapRow = (row) => row } = {}) {
  let daemon = initial;
  let losing = false;
  let publishPool = () => {};
  const handlers = new Map();
  const rowListeners = new Set();
  const sent = [];
  const bridge = new DesktopStateBridge({
    window: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame: {},
        send(channel, value) {
          if (channel !== DESKTOP_IPC.agentPoolChanged) return;
          sent.push(value);
          if (losing) return;
          const received = structuredClone(value);
          for (const change of received.changes) if (change.row) change.row = wrapRow(change.row);
          for (const listener of rowListeners) listener(received);
        },
      },
    },
    host: {
      subscribe: () => () => {},
      subscribeSessionStates: () => () => {},
      subscribeAgentPool(listener) {
        publishPool = listener;
        return () => {};
      },
      listAgentPool: async () => daemon,
      getSnapshot: () => ({}),
    },
    ipcMain: new EventEmitter(),
    handle: (channel, handler) => handlers.set(channel, handler),
  });
  const rowHost = () => ({
    subscribeAgentPoolRows(listener) {
      rowListeners.add(listener);
      return () => rowListeners.delete(listener);
    },
    readAgentPoolRows: async () => {
      const snapshot = structuredClone(await handlers.get(DESKTOP_IPC.readAgentPoolRows)({}));
      return { ...snapshot, rows: snapshot.rows.map(wrapRow) };
    },
  });
  // Today's path: the whole list on every daemon change.
  const wholeListeners = new Set();
  const wholeHost = (first) => ({
    subscribeAgentPool(listener) {
      wholeListeners.add(listener);
      return () => wholeListeners.delete(listener);
    },
    listAgentPool: async () => structuredClone(first).map(wrapRow),
  });
  return {
    bridge,
    sent,
    rowHost,
    wholeHost,
    /** A daemon change; `lost` drops its message to the renderer on both paths. */
    change(list, { lost = false } = {}) {
      daemon = list;
      losing = lost;
      publishPool(list);
      losing = false;
      if (lost) return;
      for (const listener of wholeListeners) listener(structuredClone(list).map(wrapRow));
    },
    current: () => daemon,
  };
}

async function startedStore(host) {
  const store = agentPoolStore(host);
  startAgentPool(store);
  await settle();
  return store;
}

const row = (id, status, turnStartedAt, extra = {}) => ({
  sessionId: `s${id}`,
  tag: `agent-${id}`,
  agent: 'worker',
  status,
  stage: status,
  startedAt: 1_000,
  ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
  ...extra,
});

/** One random daemon change of `list`: rows starting, finishing, cancelled,
 *  re-reported stale, restarted with newer or older origins, appearing,
 *  reappearing, disappearing, moving, or nothing at all. */
function mutate(list, random, clock, nextId) {
  const next = list.map((entry) => ({ ...entry }));
  const pick = () => next[Math.floor(random() * next.length)];
  const op = next.length === 0 ? 0 : Math.floor(random() * 11);
  const target = next.length ? pick() : null;
  switch (op) {
    case 0: {
      // New, or a session that left coming back.
      const id = random() < 0.3 ? Math.floor(random() * nextId.value) : nextId.value++;
      if (!next.some((entry) => entry.sessionId === `s${id}`)) next.push(row(id, 'running', clock));
      break;
    }
    case 1:
      Object.assign(target, { status: 'done', stage: 'done' });
      break;
    case 2: {
      const status = random() < 0.5 ? 'cancelled' : 'cancelling';
      Object.assign(target, { status, stage: status });
      break;
    }
    case 3:
      Object.assign(target, { status: 'running', stage: 'running' });
      if (random() < 0.5) delete target.turnStartedAt;
      else target.turnStartedAt = (target.turnStartedAt || clock) - Math.floor(random() * 5_000) - 1;
      break;
    case 4:
      Object.assign(target, { status: 'running', stage: 'running', turnStartedAt: clock });
      break;
    case 5:
      Object.assign(target, { status: 'running', stage: 'running', turnStartedAt: clock - 50_000 });
      break;
    case 6:
      next.splice(next.indexOf(target), 1);
      break;
    case 7:
      next.splice(next.indexOf(target), 1);
      next.unshift(target);
      break;
    case 8:
      target.toolCalls = (target.toolCalls || 0) + 1;
      break;
    case 9:
      Object.assign(target, { status: 'queued', stage: 'queued' });
      break;
    default:
      break;
  }
  return next;
}

test('10,000 random pool histories: row notifications leave the store where whole lists do', async () => {
  for (let sequence = 0; sequence < 10_000; sequence += 1) {
    const random = mulberry32(sequence + 1);
    const nextId = { value: 0 };
    let list = [];
    for (let count = Math.floor(random() * 5); count > 0; count -= 1) list = mutate(list, random, 0, nextId);
    const f = harness(list);
    const notified = await startedStore(f.rowHost());
    const whole = await startedStore(f.wholeHost(list));
    assert.deepEqual(notified.rows, whole.rows, `seed ${sequence + 1}: start`);
    const steps = 1 + Math.floor(random() * 30);
    for (let step = 1; step <= steps; step += 1) {
      list = mutate(list, random, step * 1_000, nextId);
      f.change(list);
      assert.deepEqual(notified.rows, whole.rows, `seed ${sequence + 1}, change ${step}`);
    }
    f.bridge.dispose();
  }
});

test("the review's counter-example: a finished row restarted, then re-reported with an older origin", async () => {
  const f = harness([row(1, 'done', 1_000)]);
  const notified = await startedStore(f.rowHost());
  const whole = await startedStore(f.wholeHost(f.current()));
  for (const list of [[row(1, 'running', 2_000)], [row(1, 'running', 1_500)]]) {
    f.change(list);
    assert.deepEqual(notified.rows, whole.rows);
  }
  assert.equal(notified.rows[0].turnStartedAt, 2_000, 'the later origin is kept, as on the whole-list path');
});

test('a renderer that reloads mid-stream reads the whole list once, then follows the changes', async () => {
  const f = harness([row(1, 'running', 1_000), row(2, 'running', 1_000)]);
  await startedStore(f.rowHost());
  f.change([row(1, 'cancelled', 1_000), row(2, 'running', 1_000)]);
  f.change([row(1, 'running', 900), row(2, 'done', 1_000)]);
  // The reloaded window starts from a read, as today's would from listAgentPool.
  const reloaded = await startedStore(f.rowHost());
  const whole = await startedStore(f.wholeHost(f.current()));
  for (const list of [[row(1, 'running', 800)], [row(1, 'running', 3_000), row(3, 'running', 3_000)]]) {
    f.change(list);
    assert.deepEqual(reloaded.rows, whole.rows);
  }
});

test('a missed notification reads the whole list again and the store meets the whole-list path', async () => {
  const f = harness([row(1, 'running', 1_000)]);
  const notified = await startedStore(f.rowHost());
  const whole = await startedStore(f.wholeHost(f.current()));
  f.change([row(1, 'running', 1_000), row(2, 'running', 2_000)]);
  f.change([row(2, 'running', 2_000)], { lost: true });
  f.change([row(2, 'running', 2_000), row(3, 'queued', 3_000)]);
  await settle();
  assert.deepEqual(
    notified.rows.map((entry) => entry.sessionId),
    ['s2', 's3']
  );
  assert.deepEqual(notified.rows, whole.rows);
});

test('100 single-row changes at 316 rows: rows sent and rows deep-compared, whole lists against row changes', async () => {
  const initial = Array.from({ length: 316 }, (_, index) => row(index, index < 22 ? 'running' : 'done', 1_000));
  // Every Object.keys of a delivered row is one side of a deep compare
  // (sharePoolRows' samePoolValue reads both sides' keys).
  let keyReads = 0;
  const wrapRow = (entry) =>
    new Proxy(entry, {
      ownKeys(target) {
        keyReads += 1;
        return Reflect.ownKeys(target);
      },
    });
  const f = harness(initial, { wrapRow });
  const notified = await startedStore(f.rowHost());
  let list = initial;
  const changes = (run) => {
    for (let step = 0; step < 100; step += 1) {
      list = list.map((entry, index) => (index === step % 22 ? { ...entry, toolCalls: step } : entry));
      run(list);
    }
  };
  keyReads = 0;
  changes((next) => f.change(next));
  const rowsSent = f.sent.reduce((total, message) => total + message.changes.filter((change) => change.row).length, 0);
  assert.equal(rowsSent, 100);
  const comparedNotified = keyReads / 2;
  assert.equal(comparedNotified, 100);
  f.bridge.dispose();

  const g = harness(initial, { wrapRow });
  const whole = await startedStore(g.wholeHost(initial));
  list = initial;
  keyReads = 0;
  changes((next) => g.change(next));
  assert.equal(keyReads / 2, 31_600, '316 rows deep-compared per whole-list push');
  assert.deepEqual(notified.rows, whole.rows);
  g.bridge.dispose();
});
