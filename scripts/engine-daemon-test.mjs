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
const { attachEngineDaemon, createRemoteEngineSession, negotiateEngineDaemon } =
  await import('../src/standalone/engine-daemon-client.mjs');
const { ENGINE_DAEMON_PROTOCOL, engineRuntimeVersion } =
  await import('../src/standalone/engine-daemon-protocol.mjs');

test('only the wire protocol decides whether a live daemon is usable', () => {
  const version = engineRuntimeVersion();
  const olderVersion = [...String(version).split('.').slice(0, -1), '0'].join('.');
  const base = { protocol: ENGINE_DAEMON_PROTOCOL, version };
  assert.equal(negotiateEngineDaemon(base), 'ok');
  // A different BUILD is not a reason to kill a live backend: the daemon dies
  // with its last client, so closing the app and launching the new version is
  // what picks up new code. Draining over a patch bump only cut work short.
  assert.equal(negotiateEngineDaemon({ ...base, version: olderVersion }), 'ok');
  assert.equal(negotiateEngineDaemon({ ...base, version: `${version}9` }), 'ok');
  // An incompatible wire contract is stopped outright; the client then opens
  // fresh engines on a daemon it can actually talk to.
  assert.equal(negotiateEngineDaemon({ ...base, protocol: ENGINE_DAEMON_PROTOCOL - 1 }), 'restart');
  assert.equal(negotiateEngineDaemon({ ...base, protocol: ENGINE_DAEMON_PROTOCOL - 1, busy: 1 }), 'restart');
  assert.equal(negotiateEngineDaemon({ ...base, protocol: ENGINE_DAEMON_PROTOCOL + 1, busy: 1 }), 'defer',
    'a NEWER protocol is never touched, busy or not');
});

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
    startWork() {
      state = { ...state, busy: true, items: [...state.items, { id: state.items.length + 1, text: 'working' }] };
      publish();
      return true;
    },
    boom() { throw new Error('stub failure'); },
    // A function value must never cross the wire — the sanitizer drops it.
    describe() { return { ok: true, callback() {}, when: new Date(0) }; },
    async dispose() { state = { ...state, disposed: true }; publish(); },
  };
}

async function withDaemon(run, {
  engineFactory = async () => createStubEngine(), idleEvictMs = null, evictSweepMs = null,
} = {}) {
  let clientsEmptyReason = null;
  // Client identity is what the pool refcounts views by; the tests need it to
  // act as "that client went away" without tearing down the local view.
  let lastClientToken = null;
  const service = createEngineDaemonService({
    createEngine: engineFactory,
    publishIntervalMs: 5,
    onFrame: (frame) => transport.broadcast(frame),
    idleEvictMs,
    evictSweepMs,
  });
  const transport = createEngineDaemonTransport({
    handleCall: (name, args, ctx) => {
      if (ctx?.clientToken) lastClientToken = ctx.clientToken;
      return service.handleCall(name, args, ctx);
    },
    discoveryPath: join(RUNTIME_ROOT, 'engine-daemon.json'),
    clientGraceMs: 50,
    sweepMs: 50,
    onClientsEmpty: () => { clientsEmptyReason = 'empty'; },
    onClientDropped: (token) => { service.releaseClient(token); },
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  writeFileSync(join(RUNTIME_ROOT, 'engine-daemon.json'), JSON.stringify(discovery));
  try {
    await run({
      transport, service, discovery,
      clientsEmpty: () => clientsEmptyReason,
      clientToken: () => lastClientToken,
    });
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

/** Replay a view's frame stream into the transcript it represents. Frames are
 *  DELTAS against the revision each view already holds (a full snapshot only
 *  opens the stream), so a fan-out assertion has to fold them the same way the
 *  view proxy does. */
function itemsFromFrames(frames) {
  let items = [];
  for (const frame of frames) {
    if (frame.type !== 'engine-state') continue;
    if (frame.full) { items = Array.isArray(frame.full.items) ? frame.full.items : []; continue; }
    const patch = frame.patch;
    if (!patch) continue;
    if (Array.isArray(patch.set?.items)) items = patch.set.items;
    if (patch.itemsAppend) {
      items = [...items.slice(0, patch.itemsAppend.from), ...patch.itemsAppend.values];
    }
  }
  return items;
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
      () => {
        const items = itemsFromFrames(desktopFrames);
        return items.length === 1 ? items : null;
      },
      'desktop view receives the terminal submission',
    );
    assert.equal(seen[0].text, 'from terminal');

    // ... and the reverse direction is symmetric.
    await desktop.call('engine.call', { engineId: opened.engineId, method: 'submit', args: ['from desktop'] });
    await waitFor(
      () => itemsFromFrames(terminalFrames).length === 2,
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

test('a method return leaves the view consistent immediately', async () => {
  await withDaemon(async () => {
    const view = await createRemoteEngineSession({ cwd: process.cwd() });
    // No await on a frame: an in-process store is consistent the instant the
    // method returns, and EngineHost verifies exactly that after resume().
    await view.resume('immediate-session');
    assert.equal(view.getState().sessionId, 'immediate-session');
    // submit is part of the SYNCHRONOUS store surface: it accepts inline and
    // the transcript follows, exactly like the in-process store.
    assert.equal(view.submit('immediate'), true);
    await waitFor(() => view.getState().items.at(-1)?.text === 'immediate',
      'the submitted item lands in the view');
    await view.dispose('test');
  }, { engineFactory: async () => createStubEngine('') });
});

test('a working engine outlives its last view and the next one adopts it', async () => {
  await withDaemon(async ({ service }) => {
    const before = await createRemoteEngineSession({ cwd: process.cwd() });
    await before.resume('long-running');
    await before.startWork();
    assert.equal(before.getState().busy, true, 'the engine is mid-turn');

    // The app quits / the terminal is restarted while the turn runs.
    await before.dispose('app restart');
    assert.equal(service.size, 1, 'the daemon keeps running the turn with no views attached');

    // The client comes back and resumes the same session.
    const after = await createRemoteEngineSession({ cwd: process.cwd() });
    await after.resume('long-running');
    assert.equal(after.getState().busy, true, 'the returning view rejoins the live turn');
    assert.ok(after.getState().items.some((item) => item.text === 'working'),
      'the transcript produced while nobody watched is still there');
    assert.equal(service.size, 1, 'no second engine was created for the same session');

    await after.dispose('test');
  }, { engineFactory: async () => createStubEngine('') });
});

test('one client leaving never ends the engine another client is watching', async () => {
  await withDaemon(async ({ discovery, service }) => {
    // Two SEPARATE clients (terminal process + desktop process), not two views
    // in one process: the mirror refcount inside a client cannot see the peer.
    const terminal = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const desktopFrames = [];
    const desktop = await attachEngineDaemon({
      discovery, cwd: process.cwd(), onFrame: (frame) => desktopFrames.push(frame),
    });
    const { engineId } = await terminal.call('engine.open', { cwd: process.cwd() });
    // The desktop joins the same engine exactly as an adoption does.
    await desktop.call('engine.snapshot', { engineId });

    // The terminal quits.
    const released = await terminal.call('engine.dispose', { engineId, reason: 'terminal exit' });
    assert.equal(released.retained, true, 'the engine is retained for the remaining viewer');
    assert.equal(service.size, 1, 'the engine survives the terminal exit');
    assert.ok(!desktopFrames.some((frame) => frame.type === 'engine-gone'),
      'the surviving view is never told its engine is gone');

    // …and the desktop keeps working on the very same engine.
    await desktop.call('engine.call', { engineId, method: 'submit', args: ['after terminal exit'] });
    const { snapshot } = await desktop.call('engine.snapshot', { engineId });
    assert.equal(snapshot.items.at(-1).text, 'after terminal exit');

    // The LAST viewer leaving still does not end it: an EMPTY placeholder is
    // the only thing a dispose may reclaim, and this engine carries a session.
    await desktop.call('engine.call', { engineId, method: 'resume', args: ['kept-session'] });
    await desktop.call('engine.dispose', { engineId, reason: 'desktop exit' });
    assert.equal(service.size, 1, 'a session-carrying engine outlives every view');

    await terminal.close('test');
    await desktop.close('test');
  }, { engineFactory: async () => createStubEngine('') });
});

test('a client that disappears releases its view without killing the engine', async () => {
  await withDaemon(async ({ discovery, service }) => {
    const terminal = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const desktop = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const { engineId } = await terminal.call('engine.open', { cwd: process.cwd() });
    await desktop.call('engine.snapshot', { engineId });

    // Terminal window closed with no dispose at all (deregister only).
    await terminal.close('terminal closed');
    assert.equal(service.size, 1, 'a vanished client never takes the engine with it');
    await desktop.call('engine.call', { engineId, method: 'submit', args: ['still alive'] });

    // An empty placeholder (no session, no work) is the one thing a view
    // release may reclaim — otherwise a closed pane would leak an engine.
    await desktop.call('engine.dispose', { engineId, reason: 'desktop exit' });
    assert.equal(service.size, 0, 'an empty placeholder is reclaimed on release');
    await desktop.close('test');
  }, { engineFactory: async () => createStubEngine('') });
});

test('closing every view never ends a live session engine', async () => {
  await withDaemon(async ({ service }) => {
    const terminal = await createRemoteEngineSession({ cwd: process.cwd() });
    await terminal.resume('kept-alive');
    await terminal.submit('half of a conversation');
    await waitFor(() => terminal.getState().items.length === 2, 'the session has content');

    // Idle, not busy, nobody watching — the old contract destroyed it here and
    // that is what cut a turn short when the other surface was still using it.
    await terminal.dispose('terminal exit');
    assert.equal(service.size, 1, 'the engine belongs to the daemon, not to the view');

    // Coming back adopts the SAME live engine, in-memory state intact.
    const desktop = await createRemoteEngineSession({ cwd: process.cwd() });
    await desktop.resume('kept-alive');
    assert.equal(service.size, 1, 'no second engine was loaded for the session');
    assert.ok(desktop.getState().items.some((item) => item.text === 'half of a conversation'),
      'the returning view sees the live transcript, not a disk reload');
    await desktop.dispose('test');
  }, { engineFactory: async () => createStubEngine('') });
});

test('a view told its engine is gone comes back instead of stalling', async () => {
  await withDaemon(async ({ transport, service }) => {
    const view = await createRemoteEngineSession({ cwd: process.cwd() });
    await view.resume('recovered-session');
    const original = view.engineId;

    // The daemon announces the engine is gone (shutdown, idle eviction). The old
    // contract killed the view here and every later call answered "this view is
    // disposed" — the stall. It must re-open and land back on the session.
    transport.broadcast({
      type: 'engine-gone', key: `engine-state:${original}`, engineId: original, reason: 'evicted',
    });
    await waitFor(() => view.engineId === original && service.size === 1,
      'the view re-opened and rejoined the live session engine');
    assert.equal(view.disposedView, false, 'the view stays usable');
    assert.equal(view.getState().sessionId, 'recovered-session', 'the session came back with it');

    assert.equal(view.submit('after recovery'), true);
    await waitFor(() => view.getState().items.some((item) => item.text === 'after recovery'),
      'a prompt sent after the recovery still reaches the engine');

    await view.dispose('test');
  }, { engineFactory: async () => createStubEngine('') });
});
