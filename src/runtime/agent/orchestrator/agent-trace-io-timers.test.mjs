import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-trace-io-timers-'));
const tracePath = join(dir, 'agent-trace.jsonl');
process.env.MIXDOG_AGENT_TRACE_PATH = tracePath;
process.env.MIXDOG_AGENT_TRACE_LOCAL_DISABLE = '1';

const { appendAgentTrace, drainAgentTrace, _traceIoTest } = await import('./agent-trace-io.mjs');

after(() => rmSync(dir, { recursive: true, force: true }));

const real = { setTimeout, clearTimeout, setImmediate, clearImmediate, fetch };
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => real.setImmediate(resolve));
};

// Virtual-time setTimeout/setImmediate. Pending timers are counted by callback name.
function installFakeScheduler() {
  let now = 0;
  const timers = new Map();
  const immediates = new Map();
  const handle = () => ({ unref() {} });
  globalThis.setTimeout = (fn, ms = 0) => {
    const h = handle();
    timers.set(h, { fn, at: now + ms });
    return h;
  };
  globalThis.clearTimeout = (h) => timers.delete(h);
  globalThis.setImmediate = (fn) => {
    const h = handle();
    immediates.set(h, fn);
    return h;
  };
  globalThis.clearImmediate = (h) => immediates.delete(h);

  const runImmediates = async () => {
    for (let guard = 0; immediates.size > 0; guard++) {
      assert.ok(guard < 1000, 'runaway immediate loop');
      for (const [h, fn] of [...immediates]) {
        immediates.delete(h);
        fn();
      }
      await settle();
    }
  };
  return {
    pending: (fnName) => ({
      timers: [...timers.values()].filter((t) => !fnName || t.fn.name === fnName).length,
      immediates: immediates.size,
    }),
    runImmediates,
    async advance(ms) {
      const end = now + ms;
      await runImmediates();
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
        await runImmediates();
      }
      now = end;
    },
  };
}

const okResponse = { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };

// Runs body(sched, state) under fake timers with injected discovery (state.port) and a recording fetch.
async function scenario({ port = null, fetchImpl } = {}, body) {
  const sched = installFakeScheduler();
  _traceIoTest.reset();
  const state = { port, discoveries: 0, delivered: [] };
  _traceIoTest.setReadServicePort(() => {
    state.discoveries += 1;
    return state.port;
  });
  globalThis.fetch =
    fetchImpl?.(state) ??
    (async (_url, init) => {
      state.delivered.push(JSON.parse(init.body).events.length);
      return okResponse;
    });
  try {
    await body(sched, state);
  } finally {
    Object.assign(globalThis, real);
    _traceIoTest.reset();
  }
}

function burst(n) {
  for (let i = 0; i < n; i++) appendAgentTrace({ kind: 'x', session_id: 's', payload: { i } });
}

test('dead advert + sustained burst: bounded timers/immediates, constant discovery per 5s window', () =>
  scenario({}, async (sched, state) => {
    const perWindow = [];
    for (let w = 0; w < 4; w++) {
      const before = state.discoveries;
      for (let k = 0; k < 5; k++) {
        burst(1000);
        const p = sched.pending();
        assert.ok(p.timers <= 1 && p.immediates <= 1, JSON.stringify(p));
        await sched.advance(0);
      }
      assert.equal(state.discoveries, before, 'appends must not trigger discovery');
      await sched.advance(5000);
      perWindow.push(state.discoveries - before);
      const p = sched.pending();
      assert.ok(p.timers <= 1 && p.immediates <= 1, JSON.stringify(p));
    }
    assert.deepEqual(perWindow, [1, 1, 1, 1]);
    assert.deepEqual(state.delivered, []);
  }));

test('appends neither bypass nor postpone the retry timer; recovery delivers everything', () =>
  scenario({}, async (sched, state) => {
    burst(1200);
    await sched.advance(4000);
    burst(100); // must not reset the 5s timer armed at t=0
    await sched.advance(999);
    assert.equal(state.discoveries, 0);
    state.port = 4321;
    await sched.advance(1); // t=5000: timer fires
    assert.equal(state.discoveries, 1);
    // Full batches continue immediately; the 300 partial remainder waits for the timer.
    assert.deepEqual(state.delivered, [500, 500]);
    assert.deepEqual(sched.pending(), { timers: 1, immediates: 0 });
    await sched.advance(5000);
    assert.deepEqual(state.delivered, [500, 500, 300]);
    assert.deepEqual(sched.pending(), { timers: 0, immediates: 0 });
  }));

test('partial batch is delivered on the timer', () =>
  scenario({ port: 4321 }, async (sched, state) => {
    burst(7);
    await sched.advance(5000);
    assert.deepEqual(state.delivered, [7]);
  }));

test('drainAgentTrace awaits an in-flight flush and rows appended meanwhile', () => {
  let release;
  const fetchImpl = (state) => {
    let first = true;
    return async (_url, init) => {
      state.delivered.push(JSON.parse(init.body).events.length);
      if (first) {
        first = false;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return okResponse;
    };
  };
  return scenario({ port: 4321, fetchImpl }, async (sched, state) => {
    burst(3);
    await sched.advance(5000); // flush now blocked in fetch
    burst(2);
    let done = false;
    const drain = drainAgentTrace().then(() => {
      done = true;
    });
    await settle();
    assert.equal(done, false, 'drain must wait for the in-flight flush');
    release();
    await drain;
    assert.deepEqual(state.delivered, [3, 2]);
  });
});

test('drain while the 5s timer is pending cancels that timer', () =>
  scenario({ port: 4321 }, async (sched, state) => {
    burst(3);
    assert.deepEqual(sched.pending(), { timers: 1, immediates: 0 });
    await drainAgentTrace();
    assert.deepEqual(state.delivered, [3]);
    assert.deepEqual(sched.pending(), { timers: 0, immediates: 0 });
    const discoveries = state.discoveries;
    await sched.advance(6000);
    assert.equal(state.discoveries, discoveries, 'old timer must not fire another flush');
  }));

test('queued immediate is cancelled when drain takes over; retry window is respected', () =>
  scenario({ port: 4321 }, async (sched, state) => {
    burst(1);
    await sched.advance(5000); // delivers 1 and leaves the service URL known
    burst(1200); // full batch + usable service → one queued immediate
    assert.deepEqual(sched.pending(), { timers: 0, immediates: 1 });
    state.port = null;
    globalThis.fetch = async () => {
      throw new Error('boom');
    };
    await drainAgentTrace();
    assert.deepEqual(sched.pending(), { timers: 1, immediates: 0 });
    const discoveries = state.discoveries;
    await sched.runImmediates();
    assert.equal(state.discoveries, discoveries, 'no discovery without time advancing');
    await sched.advance(4999);
    assert.equal(state.discoveries, discoveries, 'still inside the 5s retry window');
    await sched.advance(1);
    assert.equal(state.discoveries, discoveries + 1);
  }));

test('local trace write completion does not orphan a timer armed during the write', () =>
  scenario({ port: 4321 }, async (sched) => {
    process.env.MIXDOG_AGENT_TRACE_LOCAL_DISABLE = '';
    try {
      burst(100); // reaches the line threshold → write goes in flight
      burst(1); // arms a local timer while the write is in flight
      assert.equal(sched.pending('_flushLocalTrace').timers, 1);
      await _traceIoTest.localWrite(); // completion handler re-arms the continuation
      assert.equal(sched.pending('_flushLocalTrace').timers, 1, 'exactly one local timer pending');
      await sched.advance(1000); // fires the pending timer, starting the second write
      await _traceIoTest.localWrite();
      assert.equal(readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).length, 101);
      assert.equal(sched.pending('_flushLocalTrace').timers, 0);
    } finally {
      process.env.MIXDOG_AGENT_TRACE_LOCAL_DISABLE = '1';
    }
  }));
