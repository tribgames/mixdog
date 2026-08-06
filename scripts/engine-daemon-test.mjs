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
process.env.MIXDOG_ENGINE_DAEMON_SSE_PENDING_MB = '0.25';
process.env.MIXDOG_CHANNEL_DAEMON_ACTIVE_CALLS = '8';

const { createEngineDaemonTransport } = await import('../src/standalone/engine-daemon-transport.mjs');
const { createEngineDaemonService } = await import('../src/standalone/engine-daemon-service.mjs');
const { createChannelDaemonTransport } = await import('../src/standalone/channel-daemon-transport.mjs');
const {
  attachEngineDaemon, createRemoteEngineSession, negotiateEngineDaemon, probeEngineDaemonHealth,
} =
  await import('../src/standalone/engine-daemon-client.mjs');
const { probeDaemonHealth: probeChannelDaemonHealth } =
  await import('../src/standalone/channel-daemon-client.mjs');
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

function waitForSseFrame(discovery, clientToken, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      reject(new Error('timed out waiting for SSE frame'));
    }, timeoutMs);
    const req = http.request({
      hostname: '127.0.0.1',
      port: discovery.port,
      path: `/events?token=${encodeURIComponent(clientToken)}&server_token=${encodeURIComponent(discovery.token)}`,
      method: 'GET',
      headers: { 'X-Mixdog-Daemon-Token': discovery.token },
    }, (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let frame;
            try { frame = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (!predicate(frame)) continue;
            clearTimeout(timer);
            req.destroy();
            resolve(frame);
            return;
          }
        }
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      if (error?.code === 'ECONNRESET') return;
      reject(error);
    });
    req.end();
  });
}

function waitForValue(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for value'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
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

test('a live daemon SSE stream reconnects in place with the same client registration', async () => {
  const serverToken = 'server-token';
  const clientToken = 'client-token';
  const streamResponses = [];
  const reconnects = [];
  const fatals = [];
  let registrations = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (value) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      send({ status: 'ok', pid: process.pid });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      res.write(': attached\n\n');
      streamResponses.push(res);
      return;
    }
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/client/register') {
        registrations += 1;
        send({ token: clientToken, pid: process.pid });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/client/deregister') {
        send({ ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/call') {
        send({ result: 'still-connected' });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  let client = null;
  try {
    client = await attachEngineDaemon({
      discovery: { port: address.port, token: serverToken, pid: process.pid },
      onFatal: (reason) => fatals.push(reason),
      onStreamReconnect: (details) => reconnects.push(details),
      streamReconnectBaseMs: 5,
      streamReconnectMaxMs: 10,
      streamReconnectHealthGraceMs: 20,
    });
    await waitForValue(() => streamResponses.length === 1);
    streamResponses[0].end();
    assert.equal(await client.call('probe'), 'still-connected',
      'ordinary calls remain usable while only the event stream reconnects');
    await waitForValue(() => streamResponses.length === 2);
    await waitForValue(() => reconnects.length === 1);
    assert.equal(registrations, 1, 'SSE recovery reuses the original client token');
    assert.equal(fatals.length, 0);
    assert.equal(reconnects[0].reason, 'sse ended');
  } finally {
    await client?.close('test end');
    for (const response of streamResponses) {
      try { response.end(); } catch {}
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('desktop clients keep compatible install adapters isolated by module URL', async () => {
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
    const firstAgain = await service.handleCall('desktop.init', {
      desktopId: 'desktop_first_again',
      moduleUrl: pathToFileURL(firstModule).href,
    }, { clientToken: 'client_first_again' });
    assert.equal(first.desktopId, 'desktop_first');
    assert.equal(second.desktopId, 'desktop_second');
    assert.equal(firstAgain.desktopId, 'desktop_first',
      'clients from the same install reuse their adapter');
    const firstInvoked = await service.handleCall('desktop.invoke', {
      desktopId: first.desktopId,
      method: 'probe',
      args: [],
    }, { clientToken: 'client_first' });
    const secondInvoked = await service.handleCall('desktop.invoke', {
      desktopId: second.desktopId,
      method: 'probe',
      args: [],
    }, { clientToken: 'client_second' });
    assert.deepEqual(firstInvoked, { label: 'first', method: 'probe' });
    assert.deepEqual(secondInvoked, { label: 'second', method: 'probe' });
  } finally {
    await service.stop('test end');
  }
});

test('an in-place CJS desktop update loads the newly keyed artifact without replacing the old adapter', async () => {
  const modulePath = join(RUNTIME_ROOT, 'desktop-backend-in-place.cjs');
  const writeAdapter = (label) => writeFileSync(modulePath, `
    module.exports.createDesktopBackend = async function createDesktopBackend() {
      return {
        invoke() { return ${JSON.stringify(label)}; },
        async control() {},
        async dispose() {},
      };
    };
  `);
  writeAdapter('old');
  const service = createEngineDaemonService({ createEngine: async () => createStubEngine() });
  try {
    const oldBackend = await service.handleCall('desktop.init', {
      desktopId: 'desktop_in_place_old',
      moduleUrl: `${pathToFileURL(modulePath).href}?build=old`,
    }, { clientToken: 'client_in_place_old' });
    writeAdapter('new');
    const newBackend = await service.handleCall('desktop.init', {
      desktopId: 'desktop_in_place_new',
      moduleUrl: `${pathToFileURL(modulePath).href}?build=new`,
    }, { clientToken: 'client_in_place_new' });
    assert.equal(await service.handleCall('desktop.invoke', {
      desktopId: oldBackend.desktopId,
      method: 'probe',
    }), 'old');
    assert.equal(await service.handleCall('desktop.invoke', {
      desktopId: newBackend.desktopId,
      method: 'probe',
    }), 'new');
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

test('session catalog rides responses only when its revision changes', async () => {
  let scans = 0;
  const service = createEngineDaemonService({
    createEngine: async () => ({
      ...createStubEngine(),
      listSessions() {
        scans += 1;
        return [{ id: 'catalog-row', updatedAt: scans }];
      },
      renameSessionTitle() { return true; },
    }),
  });
  try {
    const created = await service.handleCall('session.create', {});
    assert.ok(Array.isArray(created.sync?.sessions));
    assert.equal(scans, 1);
    const read = await service.handleCall('session.read', {
      sessionId: created.sessionId,
      baseRevision: created.revision,
      baseSyncRevision: created.syncRevision,
    });
    assert.equal(Object.hasOwn(read, 'sync'), false);
    assert.equal(scans, 1, 'unchanged catalog does not scan or cross the wire');
    const shaped = await service.handleCall('session.invoke', {
      sessionId: created.sessionId,
      method: 'renameSessionTitle',
      args: ['renamed'],
      baseRevision: read.revision,
      baseSyncRevision: read.syncRevision,
    });
    assert.ok(Array.isArray(shaped.sync?.sessions));
    assert.equal(scans, 2);
  } finally {
    await service.stop('test end');
  }
});

test('a disconnected client receives bounded session resync markers instead of a huge backlog', async () => {
  await withDaemon(async ({ discovery, transport }) => {
    const registered = await daemonPost(discovery, '/client/register', {
      leadPid: process.pid,
      cwd: process.cwd(),
      lifecycle: false,
    });
    const target = new Set([registered.token]);
    const large = 'x'.repeat(160 * 1024);
    for (let index = 0; index < 3; index += 1) {
      transport.broadcast({
        type: 'session-state',
        key: `session-state:budget-${index}`,
        sessionId: `budget-${index}`,
        revision: index + 1,
        full: { sessionId: `budget-${index}`, items: [{ text: large }] },
      }, target);
    }
    const marker = await waitForSseFrame(
      discovery,
      registered.token,
      (frame) => frame?.resyncRequired === true,
    );
    assert.equal(marker.type, 'session-state');
    await daemonPost(discovery, '/client/deregister', { token: registered.token });
  });
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
    abort(options = {}) {
      state = { ...state, busy: false };
      publish();
      return {
        aborted: true,
        restoreText: options?.restorePrompt === false ? '' : 'restored prompt',
        pastedImages: options?.restorePrompt === false
          ? null
          : { image_1: { filename: 'restored.png' } },
      };
    },
    boom() { throw new Error('stub failure'); },
    // A function value must never cross the wire — the sanitizer drops it.
    describe() { return { ok: true, callback() {}, when: new Date(0) }; },
    async dispose() { state = { ...state, disposed: true }; publish(); },
  };
}

async function withDaemon(run, {
  engineFactory = async () => createStubEngine(), idleEvictMs = null, evictSweepMs = null,
  onClientRegistered = null, softRssMb = null,
  rssBytes = undefined,
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
    softRssMb,
    ...(rssBytes ? { rssBytes } : {}),
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

test('abort starts immediately while ordinary session calls remain in flight', async () => {
  let releaseWork;
  let startedWork = 0;
  let abortCalls = 0;
  let abortOptions = null;
  const workGate = new Promise((resolve) => { releaseWork = resolve; });
  await withDaemon(async ({ discovery }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const work = Array.from({ length: 64 }, (_, index) =>
      client.call('session.invoke', {
        sessionId,
        method: 'blockedWork',
        args: [index],
      }, { callId: `reserved-capacity-work:${index}` }));
    try {
      await waitFor(
        () => startedWork === work.length,
        'ordinary calls start without a hidden concurrency gate',
      );
      const started = performance.now();
      const result = await client.call('session.abort', {
        sessionId,
        options: { restorePrompt: false },
      }, {
        callId: 'reserved-capacity-abort',
      });
      const elapsed = performance.now() - started;
      assert.equal(result.aborted, true);
      assert.equal(result.restoreText, 'queued prompt');
      assert.deepEqual(result.pastedTexts, { text_1: { text: 'restored text' } });
      assert.deepEqual(abortOptions, { restorePrompt: false });
      assert.equal(abortCalls, 1);
      assert.ok(elapsed < 100, `abort waited ${elapsed.toFixed(1)}ms behind ordinary calls`);
    } finally {
      releaseWork();
      await Promise.all(work);
      await client.close('reserved capacity test');
    }
  }, {
    engineFactory: async () => ({
      ...createStubEngine(),
      blockedWork() {
        startedWork += 1;
        return workGate;
      },
      abort(options) {
        abortCalls += 1;
        abortOptions = options;
        return {
          aborted: true,
          restoreText: 'queued prompt',
          pastedTexts: { text_1: { text: 'restored text' } },
        };
      },
    }),
  });
});

test('independent clients and sessions start without waiting for another backlog', async () => {
  const started = [];
  const gates = new Map();
  let releaseAll = false;
  const gateFor = (label) => {
    if (releaseAll) return Promise.resolve(label);
    const gate = Promise.withResolvers();
    gates.set(label, gate);
    return gate.promise;
  };
  await withDaemon(async ({ discovery }) => {
    const noisy = await attachEngineDaemon({
      discovery, cwd: process.cwd(), leadPid: process.pid,
    });
    const victim = await attachEngineDaemon({
      discovery, cwd: process.cwd(), leadPid: process.ppid,
    });
    const { sessionId } = await noisy.call('session.create', { cwd: process.cwd() });
    const noisyWork = Array.from({ length: 60 }, (_, index) =>
      noisy.call('session.invoke', {
        sessionId,
        method: 'fairBlockedWork',
        args: [`noisy-${index}`],
      }, { callId: `fair-noisy-${index}` }));
    let victimWork = null;
    try {
      await waitFor(
        () => started.length === noisyWork.length,
        'noisy session starts its full parallel wave',
      );
      victimWork = victim.call('session.invoke', {
        sessionId,
        method: 'fairBlockedWork',
        args: ['victim'],
      }, { callId: 'fair-victim' });
      await waitFor(() => started.includes('victim'), 'victim starts without a permit release');
      const victimIndex = started.indexOf('victim');
      assert.equal(victimIndex, noisyWork.length);
    } finally {
      releaseAll = true;
      for (const gate of gates.values()) gate.resolve();
      await Promise.allSettled([...noisyWork, ...(victimWork ? [victimWork] : [])]);
      await victim.close('fairness test');
      await noisy.close('fairness test');
    }
  }, {
    engineFactory: async () => ({
      ...createStubEngine(),
      fairBlockedWork(label) {
        started.push(label);
        return gateFor(label);
      },
    }),
  });
});

test('channel calls start a second client without a synthetic global permit', async () => {
  const started = [];
  const gates = new Map();
  let releaseAll = false;
  const gateFor = (label) => {
    if (releaseAll) return Promise.resolve(label);
    const gate = Promise.withResolvers();
    gates.set(label, gate);
    return gate.promise;
  };
  const transport = createChannelDaemonTransport({
    handleCall(_name, args) {
      const label = String(args?.label || '');
      started.push(label);
      return gateFor(label);
    },
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  let noisyWork = [];
  let victimWork = null;
  try {
    const noisy = await daemonPost(discovery, '/client/register', {
      leadPid: process.pid, cwd: process.cwd(), reattach: true,
    });
    const victim = await daemonPost(discovery, '/client/register', {
      leadPid: process.ppid, cwd: process.cwd(), reattach: true,
    });
    noisyWork = Array.from({ length: 6 }, (_, index) =>
      daemonPost(discovery, '/call', {
        token: noisy.token,
        name: 'work',
        args: { label: `channel-noisy-${index}` },
        callId: `channel-noisy-${index}`,
      }));
    await waitFor(
      () => started.length === noisyWork.length,
      'channel borrower starts its full parallel wave',
    );
    victimWork = daemonPost(discovery, '/call', {
      token: victim.token,
      name: 'work',
      args: { label: 'channel-victim' },
      callId: 'channel-victim',
    });
    await waitFor(() => started.includes('channel-victim'), 'channel victim starts without a permit release');
    assert.equal(started.indexOf('channel-victim'), noisyWork.length);
  } finally {
    releaseAll = true;
    for (const gate of gates.values()) gate.resolve();
    await Promise.allSettled([...noisyWork, ...(victimWork ? [victimWork] : [])]);
    await transport.stop();
  }
});

test('call idempotency is isolated per client process', async () => {
  await withDaemon(async ({ discovery }) => {
    const first = await attachEngineDaemon({
      discovery, cwd: process.cwd(), leadPid: process.pid,
    });
    const second = await attachEngineDaemon({
      discovery, cwd: process.cwd(), leadPid: process.ppid,
    });
    const { sessionId } = await first.call('session.create', { cwd: process.cwd() });
    const args = { sessionId, method: 'submit', args: ['same payload'] };
    await first.call('session.invoke', args, { callId: 'same-process-local-id' });
    await second.call('session.invoke', args, { callId: 'same-process-local-id' });
    const read = await first.call('session.read', { sessionId });
    assert.equal(read.full.items.length, 2);
    await second.close('call cache isolation');
    await first.close('call cache isolation');
  });
});

async function waitFor(predicate, message, timeoutMs = 4000) {
  const started = Date.now();
  while (true) {
    let value;
    try { value = await predicate(); } catch (err) { throw err; }
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      const detail = typeof message === 'function' ? message() : message;
      throw new Error(`timeout: ${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10).unref?.());
  }
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
    assert.ok(created.revision > 1_000_000_000_000,
      'default daemon revisions carry a restart-monotonic compatibility epoch');
    assert.equal(created.reservedOnly, true);
    assert.equal(eagerSessionCreates, 0, 'reservation does not eagerly materialize a provider session');
    const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
    assert.equal(subscribed.subscribed, true);

    const submitted = await terminal.call('session.submit', {
      sessionId: created.sessionId,
      prompt: 'keep running',
      options: { id: 'durable-submit' },
    }, { callId: 'session-submit:durable-session:durable-submit' });
    assert.equal(submitted.accepted, true, 'submit ACKs queue intake');
    assert.equal(submitted.reservedOnly, false);
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
    await engine.startWork();
    const preserved = await engine.abortAsync({ restorePrompt: false });
    assert.equal(preserved.aborted, true);
    assert.equal(preserved.restoreText, '', 'a replacement draft suppresses prompt rewind across the daemon');
    assert.equal(preserved.pastedImages, null);
    await engine.startWork();
    const interrupted = await engine.abortAsync();
    assert.equal(interrupted.aborted, true);
    assert.equal(interrupted.restoreText, 'restored prompt');
    assert.deepEqual(interrupted.pastedImages, { image_1: { filename: 'restored.png' } });
    assert.equal(engine.getState().busy, false);
    unsubscribe();

    // Revisions are local to a session projection. This old session has
    // advanced farther than the fresh reservation, but New task must still
    // replace its transcript from the lower-numbered full baseline.
    const previousSessionId = engine.getState().sessionId;
    await engine.newSession();
    assert.notEqual(engine.getState().sessionId, previousSessionId);
    assert.deepEqual(engine.getState().items, [],
      'a fresh New task never retains the previous session transcript');

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

test('session retention exposes no RSS growth ceiling', async () => {
  await withDaemon(async ({ service }) => {
    assert.equal(Object.hasOwn(service.status, 'softRssBytes'), false);
  }, { engineFactory: async () => createStubEngine('') });
});

test('warm session runtimes survive legacy RSS pressure options', async () => {
  let rss = 1;
  await withDaemon(async ({ discovery, service }) => {
    const client = await attachEngineDaemon({ discovery, cwd: process.cwd() });
    for (const sessionId of ['warm-a', 'warm-b', 'warm-c', 'warm-d']) {
      await client.call('session.create', { sessionId, cwd: process.cwd() });
      await client.call('session.submit', {
        sessionId,
        prompt: `materialize ${sessionId}`,
        options: { id: `submit-${sessionId}` },
      });
      await client.call('session.unsubscribe', { sessionId });
    }
    assert.equal(service.size, 4, 'session count alone never evicts warm runtimes');
    assert.deepEqual(service.status, {
      live: 4,
      busy: 0,
      watched: 0,
      retained: 4,
      projected: 0,
    });
    rss = 128 * 1024 * 1024;
    await client.call('session.read', { sessionId: 'warm-d' });
    assert.equal(service.size, 4, 'RSS growth never trims daemon-owned sessions');
    assert.equal(service.status.retained, 4);
    await client.close('test');
  }, {
    engineFactory: async () => createStubEngine(''),
    softRssMb: 64,
    rssBytes: () => rss,
  });
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
