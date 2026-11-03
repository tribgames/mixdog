import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionTransport } from './session-transport.mjs';
import { SESSION_PROTOCOL } from './session-wire.mjs';
import { createAgentDispatchBroker } from './agent-dispatch-broker.mjs';
import { createWorkGate } from './daemon-work-gate.mjs';

async function harness(status, { workGate, handleCall } = {}) {
  const handled = [];
  const transport = createSessionTransport({
    handleCall:
      handleCall ??
      (async (name) => {
        handled.push(name);
        return 'ran';
      }),
    getStatus: () => status,
    ...(workGate ? { workGate } : {}),
    onClientsEmpty: () => {},
  });
  const discovery = await transport.start();
  const post = (path, body) =>
    fetch(`http://127.0.0.1:${discovery.port}${path}`, {
      method: 'POST',
      headers: { 'x-mixdog-daemon-token': discovery.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const { token } = await (await post('/client/register', { protocol: SESSION_PROTOCOL })).json();
  const call = (name) => post('/call', { token, name, args: {} });
  return { transport, post, call, handled };
}

test('install hold: idle closes new-work admission until released; reads and abort still pass', async () => {
  const status = { busy: 0 };
  const { transport, post, call, handled } = await harness(status);
  try {
    assert.deepEqual(await (await post('/install-hold', { action: 'close' })).json(), {
      ok: true,
      held: true,
      busy: 0,
    });
    assert.equal((await call('session.submit')).status, 503);
    assert.equal((await call('desktop.invoke')).status, 503);
    assert.equal((await call('session.read')).status, 200);
    assert.equal((await call('session.abort')).status, 200);
    assert.equal(handled.includes('session.submit'), false);

    await post('/install-hold', { action: 'release' });
    assert.equal((await call('session.submit')).status, 200);
  } finally {
    await transport.stop();
  }
});

test('install hold: busy at the barrier leaves admission open and reports the count', async () => {
  const status = { busy: 2 };
  const { transport, post, call } = await harness(status);
  try {
    assert.deepEqual(await (await post('/install-hold', { action: 'close' })).json(), {
      ok: true,
      held: false,
      busy: 2,
    });
    assert.equal((await call('session.submit')).status, 200);
  } finally {
    await transport.stop();
  }
});

test('install hold lapses on its own when the installer never releases it', async () => {
  const { transport, post, call } = await harness({ busy: 0 });
  try {
    await post('/install-hold', { action: 'close', ttlMs: 1_000 });
    assert.equal((await call('session.submit')).status, 503);
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    assert.equal((await call('session.submit')).status, 200);
  } finally {
    await transport.stop();
  }
});

// One interactive call at a time, so a second call has to queue behind the first.
async function withSingleInteractiveLane(fn) {
  const previous = process.env.MIXDOG_SESSION_INTERACTIVE_RESERVE;
  process.env.MIXDOG_SESSION_INTERACTIVE_RESERVE = '1';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_SESSION_INTERACTIVE_RESERVE;
    else process.env.MIXDOG_SESSION_INTERACTIVE_RESERVE = previous;
  }
}

test('a call queued before the hold is refused where it would start, not run during the teardown', async () => {
  await withSingleInteractiveLane(async () => {
    const release = Promise.withResolvers();
    const ran = [];
    const { transport, post, call } = await harness(
      { busy: 0 },
      {
        handleCall: async (name) => {
          ran.push(name);
          if (name === 'session.configure') await release.promise;
          return 'ran';
        },
      }
    );
    try {
      const running = call('session.configure');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const queued = call('session.create');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await (await post('/install-hold', { action: 'close' })).json()).held, true);

      release.resolve();
      await running;
      const envelope = await (await queued).json();
      assert.equal(envelope.code, 'EINSTALLHOLD');
      assert.deepEqual(ran, ['session.configure'], 'the queued call never started');
    } finally {
      release.resolve();
      await transport.stop();
    }
  });
});

test('running memory agent work makes the hold report busy; a memory dispatch during a hold waits for it', async () => {
  const finish = Promise.withResolvers();
  const started = [];
  let broker;
  const gate = createWorkGate({ busy: () => broker.snapshot().inFlight });
  broker = createAgentDispatchBroker({
    dispatchAgent: gate.deferring(async () => {
      started.push('agent');
      await finish.promise;
      return 'done';
    }),
  });
  try {
    const running = broker.dispatch({ agent: 'cycle1-agent', prompt: 'work' }, { callId: 'one' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Counted by the broker and, while it starts, by the gate itself.
    assert.equal(gate.hold().held, false);
    finish.resolve();
    await running;

    assert.deepEqual(gate.hold(), { held: true, busy: 0 });
    const deferred = broker.dispatch({ agent: 'cycle1-agent', prompt: 'later' }, { callId: 'two' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(started, ['agent'], 'nothing started while the gate was held');
    gate.release();
    assert.equal(await deferred, 'done');
    assert.deepEqual(started, ['agent', 'agent']);
  } finally {
    finish.resolve();
    broker.close();
  }
});

test('a start still preparing counts as running, so a hold cannot slip in before it begins', async () => {
  const gate = createWorkGate();
  const preparing = Promise.withResolvers();
  const began = [];
  const start = gate.deferring(async () => {
    await preparing.promise; // session acquisition, prompt conversion
    began.push('turn');
  });
  const turn = start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(gate.hold(), { held: false, busy: 1 });
  preparing.resolve();
  await turn;
  assert.deepEqual(began, ['turn']);
  assert.deepEqual(gate.hold(), { held: true, busy: 0 });
});

test('a cancelled deferred dispatch settles at once and its work never runs, even after release', async () => {
  const gate = createWorkGate();
  const ran = [];
  const broker = createAgentDispatchBroker({
    dispatchAgent: gate.deferring(
      async () => {
        ran.push('agent');
        return 'done';
      },
      (_payload, options) => options?.signal
    ),
  });
  try {
    assert.equal(gate.hold().held, true);
    const deferred = broker.dispatch({ agent: 'cycle1-agent', prompt: 'work' }, { callId: 'late' });
    const outcome = deferred.catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = Date.now();
    assert.equal(await broker.cancelAndWait('late'), true);
    assert.ok(Date.now() - startedAt < 500, 'cancel did not wait out the hold');
    assert.ok((await outcome) instanceof Error);
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(ran, []);
  } finally {
    broker.close();
  }
});

test('shutdown rejects every waiting start and leaves admission closed', async () => {
  const gate = createWorkGate();
  const ran = [];
  const start = gate.deferring(async () => ran.push('start'));
  assert.equal(gate.hold().held, true);
  const waiting = [start(), start()].map((promise) => promise.catch((error) => error));
  await new Promise((resolve) => setTimeout(resolve, 10));
  gate.shutdown();
  for (const outcome of await Promise.all(waiting)) assert.ok(outcome instanceof Error);
  assert.equal(gate.held, true);
  assert.equal(gate.callRefusal('session.submit') !== null, true);
  await assert.rejects(start(), Error, 'a start after shutdown is refused too');
  assert.deepEqual(ran, []);
});

test('a start is refused when shutdown came first, even with the gate open', async () => {
  const gate = createWorkGate();
  const ran = [];
  const start = gate.deferring(async () => ran.push('start'));
  gate.shutdown();
  await assert.rejects(start(), Error);
  assert.deepEqual(ran, []);
});

test('a waiter released by the hold ending but aborted before it resumes does not run', async () => {
  const gate = createWorkGate();
  const ran = [];
  const controller = new AbortController();
  const start = gate.deferring(
    async () => ran.push('start'),
    () => controller.signal
  );
  assert.equal(gate.hold().held, true);
  const waiting = start().catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  gate.release(); // wakes the waiter; its continuation is still queued
  controller.abort(new Error('cancelled'));
  assert.equal((await waiting).message, 'cancelled');
  assert.deepEqual(ran, []);
});

test('a waiter released by the hold ending but caught by shutdown before it resumes does not run', async () => {
  const gate = createWorkGate();
  const ran = [];
  const start = gate.deferring(async () => ran.push('start'));
  assert.equal(gate.hold().held, true);
  const waiting = start().catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  gate.release();
  gate.shutdown();
  assert.ok((await waiting) instanceof Error);
  assert.deepEqual(ran, []);
});
