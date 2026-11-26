import assert from 'node:assert/strict';
import test from 'node:test';

import { WAKE_GAP_MS, WAKE_POLL_MS, watchWake } from './wake-check.ts';

function rig() {
  let at = 1_000;
  let tick = () => undefined;
  const checks = [];
  const online = new Set();
  const stop = watchWake({
    check: () => checks.push(at),
    now: () => at,
    setInterval: (run) => {
      tick = run;
      return 'timer';
    },
    clearInterval: () => (tick = () => undefined),
    events: { addEventListener: (_t, run) => online.add(run), removeEventListener: (_t, run) => online.delete(run) },
  });
  return {
    checks,
    online,
    stop,
    pass: (ms) => {
      at += ms;
      return tick();
    },
  };
}

test('a clock that jumps far past the poll interval (a machine that slept) asks the core; an ordinary tick does not', () => {
  const r = rig();
  r.pass(WAKE_POLL_MS);
  r.pass(WAKE_POLL_MS + 50);
  assert.deepEqual(r.checks, []);
  r.pass(WAKE_POLL_MS + WAKE_GAP_MS + 1);
  assert.equal(r.checks.length, 1);
  r.pass(WAKE_POLL_MS);
  assert.equal(r.checks.length, 1, 'the next ordinary tick is not another wake');
});

test('the network coming back asks the core, and stopping ends both', () => {
  const r = rig();
  for (const run of r.online) run();
  assert.equal(r.checks.length, 1);
  r.stop();
  assert.equal(r.online.size, 0);
});

test('returning from hidden to visible or persisted pageshow checks immediately and stop removes listeners', () => {
  let at = 1_000;
  let tick = () => undefined;
  const checks = [];
  const winListeners = new Map();
  const docListeners = new Set();
  const visibility = {
    visibilityState: 'visible',
    addEventListener: (_t, run) => docListeners.add(run),
    removeEventListener: (_t, run) => docListeners.delete(run),
  };
  const events = {
    addEventListener: (type, run) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(run);
    },
    removeEventListener: (type, run) => winListeners.get(type)?.delete(run),
  };
  const stop = watchWake({
    check: () => checks.push(at),
    now: () => at,
    setInterval: (run) => {
      tick = run;
      return 'timer';
    },
    clearInterval: () => (tick = () => undefined),
    events,
    visibility,
  });
  const emitVisibility = (state) => {
    visibility.visibilityState = state;
    for (const run of [...docListeners]) run();
  };
  const emitPageShow = (event) => {
    for (const run of [...(winListeners.get('pageshow') ?? [])]) run(event);
  };

  emitVisibility('visible');
  assert.equal(checks.length, 0, 'staying visible does not trigger a wake check');
  emitVisibility('hidden');
  assert.equal(checks.length, 0, 'hiding does not trigger a wake check');
  at += 60_000;
  emitVisibility('visible');
  assert.equal(checks.length, 1, 'returning from hidden to visible checks immediately');
  tick();
  assert.equal(checks.length, 1, 'the next poll tick after visibility recovery does not double-check');
  emitVisibility('visible');
  assert.equal(checks.length, 1, 'repeated visible events without hidden do not re-trigger');

  emitPageShow({ persisted: false });
  assert.equal(checks.length, 1, 'non-persisted pageshow does not trigger');
  emitPageShow({ persisted: true });
  assert.equal(checks.length, 2, 'persisted pageshow triggers immediately');

  stop();
  assert.equal(docListeners.size, 0);
  assert.equal(winListeners.get('online')?.size ?? 0, 0);
  assert.equal(winListeners.get('pageshow')?.size ?? 0, 0);
  emitVisibility('hidden');
  emitVisibility('visible');
  emitPageShow({ persisted: true });
  assert.equal(checks.length, 2, 'stopped watcher ignores later events');
});

test('a watcher started while hidden checks immediately when the window becomes visible', () => {
  const checks = [];
  const docListeners = new Set();
  const visibility = {
    visibilityState: 'hidden',
    addEventListener: (_t, run) => docListeners.add(run),
    removeEventListener: (_t, run) => docListeners.delete(run),
  };
  const stop = watchWake({
    check: () => checks.push('checked'),
    setInterval: () => 'timer',
    clearInterval: () => undefined,
    visibility,
  });
  visibility.visibilityState = 'visible';
  for (const run of [...docListeners]) run();
  assert.equal(checks.length, 1);
  stop();
});

test('a partial global document mock does not throw or leak interval and window listeners', () => {
  const savedDocument = globalThis.document;
  try {
    for (const partial of [{ visibilityState: 'visible' }, { addEventListener() {} }]) {
      globalThis.document = partial;
      const checks = [];
      let cleared = 0;
      const winListeners = new Map();
      const events = {
        addEventListener: (type, run) => {
          if (!winListeners.has(type)) winListeners.set(type, new Set());
          winListeners.get(type).add(run);
        },
        removeEventListener: (type, run) => winListeners.get(type)?.delete(run),
      };
      const stop = watchWake({
        check: () => checks.push('checked'),
        setInterval: () => 'timer',
        clearInterval: () => {
          cleared += 1;
        },
        events,
      });
      for (const run of winListeners.get('online') ?? []) run();
      assert.equal(checks.length, 1);
      stop();
      assert.equal(cleared, 1);
      assert.equal(winListeners.get('online')?.size ?? 0, 0);
      assert.equal(winListeners.get('pageshow')?.size ?? 0, 0);
    }
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  }
});
