// Engine daemon contract: transport fan-out, call routing, and the remote
// engine proxy — all against a STUB engine factory so the test never boots a
// provider, model catalog, or memory runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-daemon-'));
process.env.MIXDOG_RUNTIME_ROOT = RUNTIME_ROOT;
process.env.MIXDOG_DATA_DIR = RUNTIME_ROOT;

const { createEngineDaemonTransport } = await import('../src/standalone/engine-daemon-transport.mjs');
const { createEngineDaemonService } = await import('../src/standalone/engine-daemon-service.mjs');
const { attachEngineDaemon, createRemoteEngineSession, negotiateEngineDaemon } =
  await import('../src/standalone/engine-daemon-client.mjs');
const { ENGINE_DAEMON_PROTOCOL, engineRuntimeVersion } =
  await import('../src/standalone/engine-daemon-protocol.mjs');

function daemonPost(discovery, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: discovery.port,
      path,
      method: 'POST',
      headers: {
        'X-Mixdog-Daemon-Token': discovery.token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const parsed = raw ? JSON.parse(raw) : {};
        if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        else resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

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

test('desktop clients reuse the daemon-owned adapter across different install module URLs', async () => {
  const firstModule = join(RUNTIME_ROOT, 'desktop-backend-first.mjs');
  const secondModule = join(RUNTIME_ROOT, 'desktop-backend-second.mjs');
  const adapterSource = (label) => `
    export async function createDesktopBackend() {
      return {
        invoke(method) { return { label: ${JSON.stringify(label)}, method }; },
        async control() {},
        async dispose() {},
      };
    }
  `;
  writeFileSync(firstModule, adapterSource('first'));
  writeFileSync(secondModule, adapterSource('second'));
  const service = createEngineDaemonService({ createEngine: async () => createStubEngine() });
  try {
    const first = await service.handleCall('desktop.init', {
      desktopId: 'desktop_first',
      moduleUrl: pathToFileURL(firstModule).href,
    }, { clientToken: 'client_first' });
    const second = await service.handleCall('desktop.init', {
      desktopId: 'desktop_second',
      moduleUrl: pathToFileURL(secondModule).href,
    }, { clientToken: 'client_second' });
    assert.equal(first.desktopId, 'desktop_first');
    assert.equal(second.desktopId, 'desktop_first',
      'the live daemon keeps its canonical adapter instead of rejecting another install');
    const invoked = await service.handleCall('desktop.invoke', {
      desktopId: second.desktopId,
      method: 'probe',
      args: [],
    }, { clientToken: 'client_second' });
    assert.deepEqual(invoked, { label: 'first', method: 'probe' });
  } finally {
    await service.stop('test end');
  }
});

test('the daemon injects its process-local runtime into the desktop adapter', async () => {
  const modulePath = join(RUNTIME_ROOT, 'desktop-backend-runtime.mjs');
  writeFileSync(modulePath, `
    export async function createDesktopBackend({ runtime }) {
      return {
        invoke(method) { return method === 'runtime-marker' ? runtime.marker : null; },
        async control() {},
        async dispose() {},
      };
    }
  `);
  const desktopRuntime = { marker: 'daemon-process-runtime' };
  const service = createEngineDaemonService({
    createEngine: async () => createStubEngine(),
    desktopRuntime,
  });
  try {
    const initialized = await service.handleCall('desktop.init', {
      desktopId: 'desktop_runtime',
      moduleUrl: pathToFileURL(modulePath).href,
    }, { clientToken: 'desktop_runtime_client' });
    const marker = await service.handleCall('desktop.invoke', {
      desktopId: initialized.desktopId,
      method: 'runtime-marker',
      args: [],
    }, { clientToken: 'desktop_runtime_client' });
    assert.equal(marker, desktopRuntime.marker);
  } finally {
    await service.stop('test end');
  }
});

test('session calls log only a bounded result summary, never the transcript body', async () => {
  const logs = [];
  const service = createEngineDaemonService({
    createEngine: async () => ({
      ...createStubEngine('bounded_log_session'),
      hugeResult: () => ({
        items: Array.from({ length: 200 }, (_, index) => ({
          id: index,
          text: `private-transcript-${index}-${'x'.repeat(500)}`,
        })),
      }),
    }),
    log: (line) => logs.push(line),
  });
  try {
    const result = await service.handleCall('session.invoke', {
      sessionId: 'bounded_log_session',
      method: 'hugeResult',
      args: [],
    }, { clientToken: 'bounded_log_client' });
    assert.equal(result.value.items.length, 200);
    const line = logs.find((entry) => entry.includes('session call hugeResult'));
    assert.match(line, /result=object items=200/);
    assert.doesNotMatch(line, /private-transcript/);
    assert.ok(line.length < 200);
  } finally {
    await service.stop('test end');
  }
});

test('daemon lifetime sees phone clients owned by the desktop adapter', async () => {
  const modulePath = join(RUNTIME_ROOT, 'desktop-backend-clients.mjs');
  writeFileSync(modulePath, `
    export async function createDesktopBackend({ onClientCountChanged }) {
      let clientCount = 0;
      return {
        get clientCount() { return clientCount; },
        invoke(method, args) {
          if (method === 'clients') {
            clientCount = Number(args[0]) || 0;
            onClientCountChanged();
          }
          return clientCount;
        },
        async control() {},
        async dispose() {},
      };
    }
  `);
  let changed = 0;
  const service = createEngineDaemonService({
    createEngine: async () => createStubEngine(),
    onExternalClientsChanged: () => { changed += 1; },
  });
  try {
    await service.handleCall('desktop.init', {
      desktopId: 'desktop_clients',
      moduleUrl: pathToFileURL(modulePath).href,
    }, { clientToken: 'desktop_client' });
    await service.handleCall('desktop.invoke', {
      desktopId: 'desktop_clients',
      method: 'clients',
      args: [2],
    }, { clientToken: 'desktop_client' });
    assert.equal(service.externalClientCount, 2);
    assert.equal(changed, 1);
  } finally {
    await service.stop('test end');
  }
});

function createStubEngine(sessionId = '') {
  let state = { sessionId, items: [], busy: false };
  const listeners = new Set();
  const publish = () => { for (const listener of [...listeners]) listener(); };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    reserveSession(id) {
      state = { ...state, sessionId: String(id) };
      publish();
      return true;
    },
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
  onClientRegistered = null,
} = {}) {
  let clientsEmptyReason = null;
  // Client identity is what the pool refcounts views by; the tests need it to
  // act as "that client went away" without tearing down the local view.
  let lastClientToken = null;
  const service = createEngineDaemonService({
    createEngine: engineFactory,
    publishIntervalMs: 5,
    onFrame: (frame, targetTokens) => transport.broadcast(frame, targetTokens),
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
    onClientRegistered,
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

test('the first engine client can start runtime prewarm before creating a session', async () => {
  const registrations = [];
  await withDaemon(async ({ discovery, service }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    try {
      assert.equal(service.size, 0);
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].lifecycle, true);
      assert.equal(registrations[0].cwd, process.cwd());
    } finally {
      await client.close('registration prewarm test');
    }
  }, {
    onClientRegistered: (row) => registrations.push(row),
  });
});

test('a lost registration response replays one client token instead of leaking lifecycle refs', async () => {
  await withDaemon(async ({ discovery, transport }) => {
    const body = {
      leadPid: process.pid,
      cwd: process.cwd(),
      lifecycle: true,
      registrationId: 'stable-registration-replay',
    };
    const first = await daemonPost(discovery, '/client/register', body);
    const replay = await daemonPost(discovery, '/client/register', body);
    assert.equal(replay.token, first.token);
    assert.equal(transport.connectionCount, 1);
    await daemonPost(discovery, '/client/deregister', { token: first.token });
  });
});

test('health and registration bypass a burst of synchronous session call starts', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const work = Promise.all(Array.from({ length: 64 }, (_, index) =>
      client.call('session.invoke', {
        sessionId,
        method: 'briefCpuWork',
        args: [index],
      }, { callId: `control-plane-work:${index}` })));
    await new Promise((resolve) => setImmediate(resolve));

    let newcomer = null;
    try {
      const started = performance.now();
      newcomer = await attachEngineDaemon({ discovery, cwd: process.cwd() });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 100, `registration waited ${elapsed.toFixed(1)}ms behind session calls`);
    } finally {
      await newcomer?.close('control-plane test');
      await work;
      await client.close('control-plane test');
    }
  }, {
    engineFactory: async () => ({
      ...createStubEngine(),
      briefCpuWork(index) {
        const deadline = performance.now() + 5;
        while (performance.now() < deadline) { /* deliberate synchronous slice */ }
        return index;
      },
    }),
  });
});

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
    if (frame.type !== 'session-state') continue;
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

function sessionSnapshotFromFrames(frames, sessionId) {
  let snapshot = null;
  for (const frame of frames) {
    if (frame.type !== 'session-state' || frame.sessionId !== sessionId) continue;
    if (frame.full) { snapshot = frame.full; continue; }
    if (!frame.patch) continue;
    const base = snapshot || {};
    const next = { ...base, ...(frame.patch.set || {}) };
    if (frame.patch.itemsAppend) {
      next.items = (Array.isArray(base.items) ? base.items : [])
        .slice(0, frame.patch.itemsAppend.from)
        .concat(frame.patch.itemsAppend.values || []);
    }
    for (const key of frame.patch.remove || []) delete next[key];
    snapshot = next;
  }
  return snapshot;
}

test('every attached client observes the same session snapshot stream', async () => {
  await withDaemon(async ({ discovery }) => {
    const terminalFrames = [];
    const desktopFrames = [];
    const unrelatedFrames = [];
    const terminal = await attachEngineDaemon({
      discovery, cwd: process.cwd(), onFrame: (frame) => terminalFrames.push(frame),
    });
    const desktop = await attachEngineDaemon({
      discovery, cwd: process.cwd(), onFrame: (frame) => desktopFrames.push(frame),
    });
    const unrelated = await attachEngineDaemon({
      discovery, cwd: process.cwd(), onFrame: (frame) => unrelatedFrames.push(frame),
    });
    const created = await terminal.call('session.create', { cwd: process.cwd() });
    assert.match(created.sessionId, /^sess_daemon_/);
    const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
    assert.equal(subscribed.subscribed, true);
    // Subscription state is the RPC baseline; SSE carries only later changes
    // to subscribed clients and never broadcasts another session globally.
    desktopFrames.push({
      type: 'session-state',
      sessionId: created.sessionId,
      revision: subscribed.revision,
      full: subscribed.full,
      patch: subscribed.patch,
    });

    // A terminal-side submit reaches the desktop view as shared state.
    await terminal.call('session.submit', {
      sessionId: created.sessionId, prompt: 'from terminal',
    });
    const seen = await waitFor(
      () => {
        const items = itemsFromFrames(desktopFrames);
        return items.length === 1 ? items : null;
      },
      'desktop view receives the terminal submission',
    );
    assert.equal(seen[0].text, 'from terminal');

    // ... and the reverse direction is symmetric.
    await desktop.call('session.submit', {
      sessionId: created.sessionId, prompt: 'from desktop',
    });
    await waitFor(
      () => itemsFromFrames(terminalFrames).length === 2,
      'terminal view receives the desktop submission',
    );
    assert.equal(
      unrelatedFrames.some((frame) => frame.sessionId === created.sessionId),
      false,
      'an unrelated client never receives another session transcript',
    );

    await terminal.close('test');
    await desktop.close('test');
    await unrelated.close('test');
  });
});

test('an in-daemon transport connection receives frames without owning daemon lifetime', async () => {
  await withDaemon(async ({ discovery, transport, clientsEmpty }) => {
    const external = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const internal = await attachEngineDaemon({
      discovery,
      cwd: process.cwd(),
      lifecycle: false,
    });
    assert.equal(transport.clientCount, 1);
    assert.equal(transport.connectionCount, 2);
    await external.close('external client closed');
    await waitFor(() => clientsEmpty() === 'empty', 'lifecycle emptiness ignores internal connection');
    assert.equal(transport.clientCount, 0);
    assert.equal(transport.connectionCount, 1);
    await internal.close('test');
  });
});

test('session protocol ACKs intake and unsubscribe never interrupts execution', async () => {
  let finishWork = null;
  let abortCalls = 0;
  let eagerSessionCreates = 0;
  const engineFactory = async () => {
    let state = { sessionId: '', items: [], busy: false };
    const listeners = new Set();
    const publish = () => { for (const listener of [...listeners]) listener(); };
    return {
      getState: () => state,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      reserveSession(id) {
        state = { ...state, sessionId: String(id) };
        publish();
        return true;
      },
      async newSession() {
        eagerSessionCreates += 1;
        state = { ...state, sessionId: 'durable-session' };
        publish();
        return true;
      },
      async resume(id) {
        state = { ...state, sessionId: String(id) };
        publish();
        return true;
      },
      submit(text) {
        state = {
          ...state,
          busy: true,
          items: [...state.items, { id: 'prompt', text: String(text) }],
        };
        publish();
        finishWork = () => {
          state = {
            ...state,
            busy: false,
            items: [...state.items, { id: 'answer', text: 'completed after detach' }],
          };
          publish();
        };
        return true;
      },
      abort() {
        abortCalls += 1;
        state = { ...state, busy: false };
        publish();
        return true;
      },
      resolveToolApproval() { return true; },
      async dispose() {},
    };
  };

  await withDaemon(async ({ discovery, service }) => {
    const terminalFrames = [];
    const terminal = await attachEngineDaemon({
      discovery,
      cwd: process.cwd(),
      onFrame: (frame) => terminalFrames.push(frame),
    });
    const desktop = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const created = await terminal.call('session.create', { cwd: process.cwd() });
    assert.match(created.sessionId, /^sess_daemon_/, 'create returns a daemon-reserved stable address');
    assert.equal(eagerSessionCreates, 0, 'reservation does not eagerly materialize a provider session');
    const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
    assert.equal(subscribed.subscribed, true);

    const submitted = await terminal.call('session.submit', {
      sessionId: created.sessionId,
      prompt: 'keep running',
      options: { id: 'durable-submit' },
    }, { callId: 'session-submit:durable-session:durable-submit' });
    assert.equal(submitted.accepted, true, 'submit ACKs queue intake');
    await waitFor(
      () => sessionSnapshotFromFrames(terminalFrames, created.sessionId)?.busy === true,
      'the session stream reports the accepted turn',
    );
    assert.equal(typeof finishWork, 'function', 'execution remains independently finishable after ACK');

    await desktop.call('session.unsubscribe', { sessionId: created.sessionId });
    await desktop.close('desktop closed');
    assert.equal(abortCalls, 0, 'unsubscribe and disconnect do not call abort');
    assert.equal(service.size, 1, 'the daemon still owns the session engine');

    finishWork();
    const completed = await waitFor(
      () => {
        const snapshot = sessionSnapshotFromFrames(terminalFrames, created.sessionId);
        return snapshot?.items?.at(-1)?.text === 'completed after detach' ? snapshot : null;
      },
      'terminal observes completion after desktop detach',
    );
    assert.equal(completed.busy, false);
    assert.equal(abortCalls, 0);
    await terminal.call('session.unsubscribe', { sessionId: created.sessionId });
    await terminal.close('test');
  }, { engineFactory });
});

test('engine faults answer as call errors and non-serializable values are dropped', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    await assert.rejects(
      () => client.call('session.invoke', { sessionId, method: 'boom', args: [] }),
      /stub failure/,
    );
    await assert.rejects(
      () => client.call('session.invoke', { sessionId, method: 'missingMethod', args: [] }),
      /unavailable/,
    );
    const described = await client.call('session.invoke', { sessionId, method: 'describe', args: [] });
    assert.deepEqual(described.value, { ok: true, when: '1970-01-01T00:00:00.000Z' });
    await client.close('test');
  });
});

test('a retried call with the same id runs exactly one engine mutation', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const callId = 'stable-call-id';
    await client.call('session.invoke', { sessionId, method: 'submit', args: ['once'] }, { callId });
    await client.call('session.invoke', { sessionId, method: 'submit', args: ['once'] }, { callId });
    const read = await client.call('session.read', { sessionId });
    assert.equal(read.full.items.length, 1);
    await client.close('test');
  });
});

test('the remote engine proxy keeps the store contract', async () => {
  await withDaemon(async () => {
    const engine = await createRemoteEngineSession({ cwd: process.cwd() });
    assert.equal(engine.isRemoteEngine, true);
    assert.match(engine.getState().sessionId, /^sess_daemon_/);

    let notified = 0;
    const unsubscribe = engine.subscribe(() => { notified += 1; });
    assert.equal(await engine.submit('through the proxy'), true);
    await waitFor(() => engine.getState().items?.length === 1, 'proxy mirrors its own submission');
    assert.ok(notified > 0, 'subscribers observe the mirrored snapshot');
    unsubscribe();

    // A second view shares the process attachment but owns another session.
    const second = await createRemoteEngineSession({ cwd: process.cwd() });
    assert.notEqual(second.getState().sessionId, engine.getState().sessionId);
    await second.dispose('test');
    await engine.dispose('test');
  });
});

test('the daemon signals shutdown once the last view leaves', async () => {
  await withDaemon(async ({ discovery, clientsEmpty }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    await client.call('session.create', { cwd: process.cwd() });
    await client.close('test');
    await waitFor(() => clientsEmpty() === 'empty', 'client grace elapses into shutdown');
  });
});

test('resuming a session another view already holds converges on one owner', async () => {
  await withDaemon(async ({ service }) => {
    const terminal = await createRemoteEngineSession({ cwd: process.cwd() });
    const desktop = await createRemoteEngineSession({ cwd: process.cwd() });
    assert.equal(service.size, 2, 'each new-task view starts with a reserved session');

    await terminal.resume('shared-session');
    await waitFor(() => terminal.getState().sessionId === 'shared-session',
      'the terminal view holds the resumed session');

    // The desktop resumes the SAME session: it joins the same daemon owner.
    await desktop.resume('shared-session');
    assert.equal(desktop.getState().sessionId, terminal.getState().sessionId);
    await waitFor(() => service.size === 1, 'unclaimed reservations are reclaimed internally');

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

test('a working engine outlives its last view and the next one rejoins it', async () => {
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
    const desktop = await attachEngineDaemon({
      discovery, cwd: process.cwd(),
    });
    const { sessionId } = await terminal.call('session.create', { cwd: process.cwd() });
    await desktop.call('session.subscribe', { sessionId });

    // The terminal quits.
    await terminal.close('terminal exit');
    assert.equal(service.size, 1, 'the session survives the terminal exit');

    // …and the desktop keeps working on the same session.
    await desktop.call('session.submit', { sessionId, prompt: 'after terminal exit' });
    const read = await desktop.call('session.read', { sessionId });
    assert.equal(read.full.items.at(-1).text, 'after terminal exit');

    // The last viewer leaving still does not end a materialized session.
    await desktop.call('session.unsubscribe', { sessionId });
    assert.equal(service.size, 1, 'a session-carrying engine outlives every view');

    await desktop.close('test');
  }, { engineFactory: async () => createStubEngine('') });
});

test('a client that disappears releases its view without killing the engine', async () => {
  await withDaemon(async ({ discovery, service }) => {
    const terminal = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const desktop = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const { sessionId } = await terminal.call('session.create', { cwd: process.cwd() });
    await desktop.call('session.subscribe', { sessionId });

    // Terminal window closed with no dispose at all (deregister only).
    await terminal.close('terminal closed');
    assert.equal(service.size, 1, 'a vanished client never takes the session from another viewer');
    const read = await desktop.call('session.read', { sessionId });
    assert.equal(read.sessionId, sessionId);

    // An unclaimed reservation is reclaimed by daemon policy, not client dispose.
    await desktop.call('session.unsubscribe', { sessionId });
    assert.equal(service.size, 0, 'an unclaimed reservation is reclaimed on unsubscribe');
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

    // Coming back rejoins the SAME live engine, in-memory state intact.
    const desktop = await createRemoteEngineSession({ cwd: process.cwd() });
    await desktop.resume('kept-alive');
    assert.equal(service.size, 1, 'no second engine was loaded for the session');
    assert.ok(desktop.getState().items.some((item) => item.text === 'half of a conversation'),
      'the returning view sees the live transcript, not a disk reload');
    await desktop.dispose('test');
  }, { engineFactory: async () => createStubEngine('') });
});

test('a view told its session was unloaded comes back instead of stalling', async () => {
  await withDaemon(async ({ transport, service }) => {
    const view = await createRemoteEngineSession({ cwd: process.cwd() });
    await view.resume('recovered-session');
    // The daemon announces an idle unload. The projection must subscribe again
    // without exposing or recovering an internal engine handle.
    transport.broadcast({
      type: 'session-gone', key: 'session-state:recovered-session',
      sessionId: 'recovered-session', reason: 'evicted',
    });
    await waitFor(() => view.getState().sessionId === 'recovered-session' && service.size === 1,
      'the view rejoined the session');
    assert.equal(view.disposedView, false, 'the view stays usable');
    assert.equal(view.getState().sessionId, 'recovered-session', 'the session came back with it');

    assert.equal(view.submit('after recovery'), true);
    await waitFor(() => view.getState().items.some((item) => item.text === 'after recovery'),
      'a prompt sent after the recovery still reaches the engine');

    await view.dispose('test');
  }, { engineFactory: async () => createStubEngine('') });
});
