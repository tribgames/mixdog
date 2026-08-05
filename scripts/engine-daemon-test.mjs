// Engine daemon contract: transport fan-out, call routing, and the remote
// engine proxy — all against a STUB engine factory so the test never boots a
// provider, model catalog, or memory runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-daemon-'));
process.env.MIXDOG_RUNTIME_ROOT = RUNTIME_ROOT;
process.env.MIXDOG_DATA_DIR = RUNTIME_ROOT;

const { createEngineDaemonTransport } = await import('../src/standalone/engine-daemon-transport.mjs');
const { createEngineDaemonService } = await import('../src/standalone/engine-daemon-service.mjs');
const { attachEngineDaemon, createRemoteEngineSession } = await import('../src/standalone/engine-daemon-client.mjs');

function createStubEngine(sessionId = 'stub-session') {
  let state = { sessionId, items: [], busy: false };
  const listeners = new Set();
  const publish = () => { for (const listener of [...listeners]) listener(); };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    submit(text) {
      state = { ...state, items: [...state.items, { id: state.items.length + 1, text: String(text) }] };
      publish();
      return true;
    },
    async resume(id) {
      state = { ...state, sessionId: String(id), items: [{ id: 1, text: `resumed ${id}` }] };
      publish();
      return true;
    },
    boom() { throw new Error('stub failure'); },
    // A function value must never cross the wire — the sanitizer drops it.
    describe() { return { ok: true, callback() {}, when: new Date(0) }; },
    async dispose() { state = { ...state, disposed: true }; publish(); },
  };
}

async function withDaemon(run, { engineFactory = async () => createStubEngine() } = {}) {
  let clientsEmptyReason = null;
  const service = createEngineDaemonService({
    createEngine: engineFactory,
    publishIntervalMs: 5,
    onFrame: (frame) => transport.broadcast(frame),
  });
  const transport = createEngineDaemonTransport({
    handleCall: (name, args) => service.handleCall(name, args),
    discoveryPath: join(RUNTIME_ROOT, 'engine-daemon.json'),
    clientGraceMs: 50,
    sweepMs: 50,
    onClientsEmpty: () => { clientsEmptyReason = 'empty'; },
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  writeFileSync(join(RUNTIME_ROOT, 'engine-daemon.json'), JSON.stringify(discovery));
  try {
    await run({ transport, service, discovery, clientsEmpty: () => clientsEmptyReason });
  } finally {
    await service.stop('test end');
    await transport.stop();
  }
}

function waitFor(predicate, message, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (err) { reject(err); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timeout: ${message}`)); return; }
      setTimeout(tick, 10).unref?.();
    };
    tick();
  });
}

test('every attached client observes the same engine snapshot stream', async () => {
  await withDaemon(async ({ discovery }) => {
    const terminalFrames = [];
    const desktopFrames = [];
    const terminal = await attachEngineDaemon({
      discovery, cwd: process.cwd(), onFrame: (frame) => terminalFrames.push(frame),
    });
    const desktop = await attachEngineDaemon({
      discovery, cwd: process.cwd(), onFrame: (frame) => desktopFrames.push(frame),
    });
    const opened = await terminal.call('engine.open', { cwd: process.cwd() });
    assert.equal(opened.snapshot.sessionId, 'stub-session');

    // The DESKTOP view never called open, yet it must see the engine.
    await waitFor(() => desktopFrames.some((frame) => frame.engineId === opened.engineId),
      'desktop view receives the opened engine frame');

    // A terminal-side submit reaches the desktop view as shared state.
    await terminal.call('engine.call', { engineId: opened.engineId, method: 'submit', args: ['from terminal'] });
    const seen = await waitFor(
      () => desktopFrames.filter((frame) => frame.type === 'engine-state')
        .map((frame) => frame.snapshot)
        .find((snapshot) => snapshot?.items?.length === 1),
      'desktop view receives the terminal submission',
    );
    assert.equal(seen.items[0].text, 'from terminal');

    // ... and the reverse direction is symmetric.
    await desktop.call('engine.call', { engineId: opened.engineId, method: 'submit', args: ['from desktop'] });
    await waitFor(
      () => terminalFrames.filter((frame) => frame.type === 'engine-state')
        .some((frame) => frame.snapshot?.items?.length === 2),
      'terminal view receives the desktop submission',
    );

    await terminal.close('test');
    await desktop.close('test');
  });
});

test('engine faults answer as call errors and non-serializable values are dropped', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const { engineId } = await client.call('engine.open', { cwd: process.cwd() });
    await assert.rejects(
      () => client.call('engine.call', { engineId, method: 'boom', args: [] }),
      /stub failure/,
    );
    await assert.rejects(
      () => client.call('engine.call', { engineId, method: 'missingMethod', args: [] }),
      /unavailable/,
    );
    const described = await client.call('engine.call', { engineId, method: 'describe', args: [] });
    assert.deepEqual(described.value, { ok: true, when: '1970-01-01T00:00:00.000Z' });
    await client.close('test');
  });
});

test('a retried call with the same id runs exactly one engine mutation', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const { engineId } = await client.call('engine.open', { cwd: process.cwd() });
    const callId = 'stable-call-id';
    await client.call('engine.call', { engineId, method: 'submit', args: ['once'] }, { callId });
    await client.call('engine.call', { engineId, method: 'submit', args: ['once'] }, { callId });
    const { snapshot } = await client.call('engine.snapshot', { engineId });
    assert.equal(snapshot.items.length, 1);
    await client.close('test');
  });
});

test('the remote engine proxy keeps the store contract', async () => {
  await withDaemon(async () => {
    const engine = await createRemoteEngineSession({ cwd: process.cwd() });
    assert.equal(engine.isRemoteEngine, true);
    assert.equal(engine.getState().sessionId, 'stub-session');

    let notified = 0;
    const unsubscribe = engine.subscribe(() => { notified += 1; });
    assert.equal(await engine.submit('through the proxy'), true);
    await waitFor(() => engine.getState().items?.length === 1, 'proxy mirrors its own submission');
    assert.ok(notified > 0, 'subscribers observe the mirrored snapshot');
    unsubscribe();

    // A second view of the SAME daemon shares the attachment and the engine.
    const second = await createRemoteEngineSession({ cwd: process.cwd() });
    assert.notEqual(second.engineId, engine.engineId);
    await second.dispose('test');
    await engine.dispose('test');
  });
});

test('the daemon signals shutdown once the last view leaves', async () => {
  await withDaemon(async ({ discovery, clientsEmpty }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    await client.call('engine.open', { cwd: process.cwd() });
    await client.close('test');
    await waitFor(() => clientsEmpty() === 'empty', 'client grace elapses into shutdown');
  });
});

test('resuming a session another view already holds adopts that engine', async () => {
  await withDaemon(async ({ service }) => {
    // Fresh placeholder engines (no session) — exactly what a new terminal or a
    // new desktop window boots with before the user opens a session.
    const terminal = await createRemoteEngineSession({ cwd: process.cwd() });
    const desktop = await createRemoteEngineSession({ cwd: process.cwd() });
    assert.equal(service.size, 2, 'each view starts on its own placeholder engine');

    await terminal.resume('shared-session');
    await waitFor(() => terminal.getState().sessionId === 'shared-session',
      'the terminal view holds the resumed session');

    // The desktop resumes the SAME session: it must join the live engine, not
    // load a second copy of it.
    await desktop.resume('shared-session');
    assert.equal(desktop.engineId, terminal.engineId, 'both views converge on one engine');
    await waitFor(() => service.size === 1, 'the idle placeholder engine is released');

    await desktop.submit('typed in the desktop');
    await waitFor(() => terminal.getState().items.some((item) => item.text === 'typed in the desktop'),
      'the terminal view sees the desktop edit on the shared engine');

    await terminal.submit('typed in the terminal');
    await waitFor(() => desktop.getState().items.some((item) => item.text === 'typed in the terminal'),
      'the desktop view sees the terminal edit on the shared engine');

    await desktop.dispose('test');
    await terminal.dispose('test');
  }, { engineFactory: async () => createStubEngine('') });
});
