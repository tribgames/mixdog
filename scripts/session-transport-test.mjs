// Session transport contract: transport fan-out, call routing, and the remote
// runtime proxy — all against a STUB runtime factory so the test never boots a
// provider, model catalog, or memory runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applySessionStatePatch,
  diffSessionState,
} from '../src/standalone/session-state-patch.mjs';

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'mixdog-session-transport-'));
process.env.MIXDOG_RUNTIME_ROOT = RUNTIME_ROOT;
process.env.MIXDOG_DATA_DIR = RUNTIME_ROOT;
process.env.MIXDOG_SESSION_SSE_PENDING_MB = '0.25';
process.env.MIXDOG_CHANNEL_ACTIVE_CALLS = '8';

const { createSessionTransport } = await import('../src/standalone/session-transport.mjs');
const { createSessionService } = await import('../src/standalone/session-service.mjs');
const { SESSION_READ_ACTIONS } = await import('../src/standalone/session-protocol.mjs');
const { createChannelTransport } = await import('../src/standalone/channel-transport.mjs');
const {
  cleanupBackgroundTasks,
  completeBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
} = await import('../src/runtime/shared/background-tasks.mjs');
const {
  attachSession, createSession, probeSessionHealth,
  daemonShouldDetach, sessionDaemonCompatibility,
} =
  await import('../src/standalone/session-client.mjs');
const { createProjectPicker } = await import('../src/tui/app/project-picker.mjs');
const { createSessionApiA } = await import('../src/tui/session/session-api.mjs');
const { createSessionApiB } = await import('../src/tui/session/session-api-ext.mjs');
const {
  appendTuiSteeringPersist,
  drainTuiSteeringPersist,
} = await import('../src/tui/session/tui-steering-persist.mjs');
const { createSessionOAuthFlowRegistry } =
  await import('../src/tui/session/oauth-flows.mjs');
const {
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
} =
  await import('../src/standalone/session-wire.mjs');

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
      path: `/events?token=${encodeURIComponent(clientToken)}`,
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

test('protocol stays at 1 while revision then app build chooses the daemon', () => {
  assert.equal(SESSION_PROTOCOL, 1);
  assert.equal(SESSION_REVISION, 3);
  assert.match(SESSION_CAPABILITY_FINGERPRINT, /^[0-9a-f]{16}$/);
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 1,
    version: '1.2.3',
    capabilityFingerprint: '0000000000000000',
  }, { revision: 1, version: '1.2.3' }).status, 'compatible');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 1,
    version: '1.2.2',
  }, { revision: 1, version: '1.2.3' }).status, 'client-newer');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 1,
    version: '1.2.4',
  }, { revision: 1, version: '1.2.3' }).status, 'daemon-newer');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 2,
    version: '1.0.0',
  }, { revision: 1, version: '9.0.0' }).status, 'daemon-newer');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 0,
    version: '9.0.0',
  }, { revision: 1, version: '1.0.0' }).status, 'client-newer');
  assert.equal(sessionDaemonCompatibility({
    protocol: 2,
    revision: 99,
    version: '1.0.0',
  }, { revision: 1, version: '9.0.0' }).status, 'protocol-mismatch');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 1,
    version: '1.2.3',
    capabilityFingerprint: '0000000000000000',
  }, { revision: 1, version: '1.2.3' }).capabilityMismatch, true);
});

test('Windows Desktop daemon stays in one Mixdog process tree while CLI daemons detach', () => {
  assert.equal(daemonShouldDetach({ platform: 'win32', processType: 'browser' }), false);
  assert.equal(daemonShouldDetach({ platform: 'win32', processType: undefined }), true);
  assert.equal(daemonShouldDetach({ platform: 'linux', processType: 'browser' }), true);
});

test('a 2k-item tool-card update sends only the changed transcript suffix', () => {
  const items = Array.from({ length: 2_000 }, (_, index) => ({
    id: `item-${index}`,
    kind: index === 1_999 ? 'tool' : 'message',
    status: 'settled',
    text: `row-${index}`,
  }));
  const nextItems = items.slice();
  nextItems[1_999] = { ...nextItems[1_999], status: 'completed', text: 'tool result' };
  const previous = { sessionId: 'suffix-test', busy: true, items };
  const next = { sessionId: 'suffix-test', busy: false, items: nextItems };
  const patch = diffSessionState(previous, next);

  assert.equal(Object.hasOwn(patch.set, 'items'), false);
  assert.deepEqual(patch.itemsAppend, { from: 1_999, values: [nextItems[1_999]] });
  assert.ok(JSON.stringify(patch).length < 512, 'one tool update stays independent of transcript size');
  assert.deepEqual(applySessionStatePatch(previous, patch), next);
});

test('daemon-owned OAuth flows expose serializable status, completion, and cancellation', async () => {
  const registry = createSessionOAuthFlowRegistry();
  let cancelled = 0;
  try {
    const started = registry.register({
      provider: 'anthropic-oauth',
      manualUrl: 'https://example.test/oauth',
      completeCode: async (code) => code === 'code-123',
    });
    assert.equal(started.state, 'pending');
    assert.equal(started.manualCodeSupported, true);
    assert.doesNotThrow(() => structuredClone(started));
    const completed = await registry.complete(started.flowId, 'code-123');
    assert.equal(completed.state, 'complete');
    assert.equal(completed.completed, true);

    const second = registry.register({
      provider: 'openai',
      cancel: async () => { cancelled += 1; },
    });
    const cancelledStatus = await registry.cancel(second.flowId);
    assert.equal(cancelledStatus.state, 'cancelled');
    assert.equal(cancelled, 1);
    // Terminal flows stay queryable (oauth-flows.test.mjs owns this contract);
    // only cancelAll() drops them from the registry.
    assert.equal(registry.status(second.flowId).state, 'cancelled');
  } finally {
    registry.cancelAll();
  }
});

test('health and registration expose the current protocol', async () => {
  await withDaemon(async ({ discovery }) => {
    const health = await probeSessionHealth(discovery);
    assert.equal(health?.protocol, SESSION_PROTOCOL);
    assert.equal(health?.revision, SESSION_REVISION);
    assert.equal(health?.capabilityFingerprint, SESSION_CAPABILITY_FINGERPRINT);
    await assert.rejects(
      daemonPost(discovery, '/client/register', {
        leadPid: process.pid,
        cwd: process.cwd(),
        lifecycle: false,
      }),
      /session protocol 1 required/,
    );
    const client = await attachSession({ discovery, cwd: process.cwd() });
    try {
      assert.equal(client.protocol, SESSION_PROTOCOL);
      assert.equal(client.revision, SESSION_REVISION);
    } finally {
      await client.close('protocol contract verified');
    }
  });
});

test('revision 0 clients keep read compatibility without retired channel mutations', async () => {
  const calls = [];
  const service = createSessionService({
    createSessionRuntime: async () => Object.assign(createStubSessionRuntime(), {
      listProviderModels() {
        calls.push(['listProviderModels']);
        return ['model-a'];
      },
    }),
  });
  try {
    const ctx = { clientToken: 'revision_zero', revision: 0 };
    const created = await service.handleCall('session.create', {
      sessionId: 'revision_zero_session',
    }, ctx);
    const models = await service.handleCall('session.configure', {
      sessionId: created.sessionId,
      action: 'listProviderModels',
    }, ctx);
    assert.deepEqual(models.value, ['model-a']);
    assert.deepEqual(calls, [['listProviderModels']]);
    await assert.rejects(
      service.handleCall('session.configure', {
        sessionId: created.sessionId,
        action: 'setBackend',
        args: ['discord'],
      }, ctx),
      /session action setBackend is unavailable/,
    );
  } finally {
    await service.stop('test end');
  }
});

test('a higher app build request drains clients and rejects fresh registration', async () => {
  let transport;
  let upgrade = null;
  transport = createSessionTransport({
    handleCall: async () => null,
    clientGraceMs: 5,
    onClientsEmpty: () => {},
    onUpgradeRequested(details) {
      upgrade = details;
      transport.beginDrain(`test replacement by ${details.version}`);
    },
  });
  const discovery = await transport.start();
  try {
    const registered = await daemonPost(discovery, '/client/register', {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      leadPid: process.pid,
      lifecycle: false,
    });
    assert.ok(registered.token);
    const accepted = await daemonPost(discovery, '/upgrade', {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      version: '9999.0.0',
    });
    assert.equal(accepted.accepted, true);
    await waitForValue(() => upgrade);
    assert.equal(upgrade.protocol, SESSION_PROTOCOL);
    assert.equal(upgrade.version, '9999.0.0');
    await assert.rejects(
      daemonPost(discovery, '/client/register', {
        protocol: SESSION_PROTOCOL,
        revision: SESSION_REVISION,
        leadPid: process.pid,
      }),
      /daemon is draining/,
    );
  } finally {
    await transport.stop();
  }
});

test('a higher API revision drains the lower-revision daemon at the same app version', async () => {
  let transport;
  let upgrade = null;
  transport = createSessionTransport({
    handleCall: async () => null,
    clientGraceMs: 5,
    onClientsEmpty: () => {},
    onUpgradeRequested(details) {
      upgrade = details;
      transport.beginDrain('test equal-version replacement');
    },
  });
  const discovery = await transport.start();
  try {
    const accepted = await daemonPost(discovery, '/upgrade', {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION + 1,
      version: runtimeVersion(),
    });
    assert.equal(accepted.accepted, true);
    await waitForValue(() => upgrade);
    assert.equal(upgrade.revision, SESSION_REVISION + 1);
  } finally {
    await transport.stop();
  }
});

test('an unknown session subscription is rejected before a session runtime is created', async () => {
  let creations = 0;
  const service = createSessionService({
    createSessionRuntime: async () => {
      creations += 1;
      throw new Error('an unknown session must not reach the runtime factory');
    },
    sessionExists: async () => false,
  });
  try {
    await assert.rejects(
      service.handleCall('session.subscribe', {
        sessionId: 'missing_session',
      }, { clientToken: 'stale_pane' }),
      /session missing_session is not available/,
    );
    assert.equal(creations, 0);
    assert.equal(service.size, 0);
  } finally {
    await service.stop('test end');
  }
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
    const send = (value, statusCode = 200) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      send({ error: 'temporarily overloaded' }, 503);
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
    client = await attachSession({
      discovery: { port: address.port, token: serverToken, pid: process.pid },
      onFatal: (reason) => fatals.push(reason),
      onStreamReconnect: (details) => reconnects.push(details),
      streamReconnectBaseMs: 5,
      streamReconnectMaxMs: 10,
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

test('desktop clients keep install adapters isolated by module URL', async () => {
  const firstModule = join(RUNTIME_ROOT, 'desktop-service-first.mjs');
  const secondModule = join(RUNTIME_ROOT, 'desktop-service-second.mjs');
  const adapterSource = (label) => `
    export async function createDesktopService() {
      return {
        invoke(method) { return { label: ${JSON.stringify(label)}, method }; },
        async control() {},
        async dispose() {},
      };
    }
  `;
  writeFileSync(firstModule, adapterSource('first'));
  writeFileSync(secondModule, adapterSource('second'));
  const service = createSessionService({ createSessionRuntime: async () => createStubSessionRuntime() });
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
  const modulePath = join(RUNTIME_ROOT, 'desktop-service-in-place.cjs');
  const writeAdapter = (label) => writeFileSync(modulePath, `
    module.exports.createDesktopService = async function createDesktopService() {
      return {
        invoke() { return ${JSON.stringify(label)}; },
        async control() {},
        async dispose() {},
      };
    };
  `);
  writeAdapter('old');
  const service = createSessionService({ createSessionRuntime: async () => createStubSessionRuntime() });
  try {
    const oldService = await service.handleCall('desktop.init', {
      desktopId: 'desktop_in_place_old',
      moduleUrl: `${pathToFileURL(modulePath).href}?build=old`,
    }, { clientToken: 'client_in_place_old' });
    writeAdapter('new');
    const newService = await service.handleCall('desktop.init', {
      desktopId: 'desktop_in_place_new',
      moduleUrl: `${pathToFileURL(modulePath).href}?build=new`,
    }, { clientToken: 'client_in_place_new' });
    assert.equal(await service.handleCall('desktop.invoke', {
      desktopId: oldService.desktopId,
      method: 'probe',
    }), 'old');
    assert.equal(await service.handleCall('desktop.invoke', {
      desktopId: newService.desktopId,
      method: 'probe',
    }), 'new');
  } finally {
    await service.stop('test end');
  }
});

test('the daemon injects its process-local runtime into the desktop adapter', async () => {
  const modulePath = join(RUNTIME_ROOT, 'desktop-service-runtime.mjs');
  writeFileSync(modulePath, `
    export async function createDesktopService({ runtime }) {
      return {
        invoke(method) { return method === 'runtime-marker' ? runtime.marker : null; },
        async control() {},
        async dispose() {},
      };
    }
  `);
  const desktopRuntime = { marker: 'daemon-process-runtime' };
  const service = createSessionService({
    createSessionRuntime: async () => createStubSessionRuntime(),
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

test('project registry and filesystem operations have one explicit daemon API', async () => {
  const rows = [];
  const touched = [];
  const projectStore = {
    listProjects: () => rows,
    resolveProjectPath: (value) => `resolved:${value}`,
    pathExists: (value) => value.includes('existing'),
    isDirectory: (value) => value.includes('directory'),
    addProject: (value) => {
      const project = { name: 'Added', path: value };
      rows.push(project);
      return project;
    },
    touchProjectSelected: (value) => {
      touched.push(value);
      return rows.find((row) => row.path === value) || null;
    },
    renameProject: (value, name) => {
      const project = rows.find((row) => row.path === value);
      if (!project) return null;
      project.name = name;
      return project;
    },
    removeProject: (value) => {
      const index = rows.findIndex((row) => row.path === value);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    ensureDir: (value) => `created:${value}`,
  };
  const service = createSessionService({
    createSessionRuntime: async () => createStubSessionRuntime(),
    desktopRuntime: { loadProjects: async () => projectStore },
  });
  try {
    assert.deepEqual(await service.handleCall('project.list'), { projects: [] });
    assert.deepEqual(await service.handleCall('project.inspect', {
      path: 'existing-directory',
    }), {
      path: 'resolved:existing-directory',
      exists: true,
      directory: true,
    });
    const added = await service.handleCall('project.add', { path: 'C:\\project' });
    assert.equal(added.project.path, 'C:\\project');
    await service.handleCall('project.touch', { path: 'C:\\project' });
    assert.deepEqual(touched, ['C:\\project']);
    const renamed = await service.handleCall('project.rename', {
      path: 'C:\\project',
      name: 'Renamed',
    });
    assert.equal(renamed.project.name, 'Renamed');
    assert.deepEqual(await service.handleCall('project.ensureDirectory', {
      path: 'C:\\new',
    }), { path: 'created:C:\\new' });
    assert.deepEqual(await service.handleCall('project.remove', {
      path: 'C:\\project',
    }), { removed: true });
  } finally {
    await service.stop('test end');
  }
});

test('the TUI project picker awaits service switches and contains service failures', async () => {
  const calls = [];
  const notices = [];
  let picker = null;
  const factory = createProjectPicker({
    state: { cwd: 'C:\\current' },
    store: {
      listProjects: async () => [{ name: 'One', path: 'C:\\one' }],
      setCwd: async (path) => {
        calls.push(`cwd:${path}`);
        return path;
      },
      addProject: async (path) => {
        calls.push(`add:${path}`);
        return { name: 'One', path };
      },
      pushNotice: (message, tone) => notices.push([message, tone]),
    },
    setPicker: (next) => {
      picker = typeof next === 'function' ? next(picker) : next;
    },
    setProviderPrompt: () => {},
    setChannelPrompt: () => {},
    setHookPrompt: () => {},
    setSettingsPrompt: () => {},
    setContextPanel: () => {},
    closeUsagePanel: () => {},
    projectNameFromPath: (value) => value,
    pickFolder: async () => ({ available: true, path: null }),
  });
  await factory.openProjectPicker();
  assert.equal(picker.items[0].value, 'C:\\one');
  assert.equal(await factory.enterProject('C:\\one'), true);
  assert.deepEqual(calls, ['cwd:C:\\one', 'add:C:\\one']);

  const failed = createProjectPicker({
    state: { cwd: 'C:\\current' },
    store: {
      setCwd: async () => { throw new Error('service rejected cwd'); },
      pushNotice: (message, tone) => notices.push([message, tone]),
    },
    setPicker: () => {},
    setProviderPrompt: () => {},
    setChannelPrompt: () => {},
    setHookPrompt: () => {},
    setSettingsPrompt: () => {},
    setContextPanel: () => {},
    closeUsagePanel: () => {},
    projectNameFromPath: (value) => value,
    pickFolder: async () => ({ available: true, path: null }),
  });
  assert.equal(await failed.enterProject('C:\\broken'), false);
  assert.ok(notices.some(([message, tone]) =>
    tone === 'error' && /service rejected cwd/.test(message)));
});

test('session calls log only a bounded result summary, never the transcript body', async () => {
  const logs = [];
  const service = createSessionService({
    createSessionRuntime: async () => ({
      ...createStubSessionRuntime('bounded_log_session'),
      getSettingsSnapshot: () => ({
        items: Array.from({ length: 200 }, (_, index) => ({
          id: index,
          text: `private-transcript-${index}-${'x'.repeat(500)}`,
        })),
      }),
    }),
    log: (line) => logs.push(line),
  });
  try {
    const result = await service.handleCall('session.read', {
      sessionId: 'bounded_log_session',
      action: 'getSettingsSnapshot',
      args: [],
    }, { clientToken: 'bounded_log_client' });
    assert.equal(result.value.items.length, 200);
    const line = logs.find((entry) => entry.includes('session action getSettingsSnapshot'));
    assert.match(line, /result=object items=200/);
    assert.doesNotMatch(line, /private-transcript/);
    assert.ok(line.length < 200);
  } finally {
    await service.stop('test end');
  }
});

test('session catalog has one explicit route and never rides session responses', async () => {
  let scans = 0;
  const service = createSessionService({
    createSessionRuntime: async () => ({
      ...createStubSessionRuntime(),
      renameSessionTitle() { return true; },
    }),
    listSessions() {
      scans += 1;
      return [{ id: 'catalog-row', updatedAt: scans }];
    },
    getRemoteSessionState() {
      return { enabled: true, sessionId: 'catalog-row' };
    },
  });
  try {
    const firstCatalog = await service.handleCall('session.list', {});
    assert.ok(Array.isArray(firstCatalog.sessions));
    assert.deepEqual(firstCatalog.remoteSession, {
      enabled: true,
      sessionId: 'catalog-row',
    });
    assert.equal(scans, 1);
    const created = await service.handleCall('session.create', {});
    assert.equal(Object.hasOwn(created, 'sync'), false);
    const read = await service.handleCall('session.read', {
      sessionId: created.sessionId,
      baseRevision: created.revision,
    });
    assert.equal(Object.hasOwn(read, 'sync'), false);
    assert.equal(scans, 1, 'session reads do not scan or carry the catalog');
    const configured = await service.handleCall('session.configure', {
      sessionId: created.sessionId,
      action: 'renameSessionTitle',
      args: ['renamed'],
      baseRevision: read.revision,
    });
    assert.equal(Object.hasOwn(configured, 'sync'), false);
    const secondCatalog = await service.handleCall('session.list', {});
    assert.ok(Array.isArray(secondCatalog.sessions));
    assert.equal(scans, 2);
  } finally {
    await service.stop('test end');
  }
});

test('a disconnected client receives bounded session resync markers instead of a huge backlog', async () => {
  await withDaemon(async ({ discovery, transport }) => {
    const registered = await daemonPost(discovery, '/client/register', {
      protocol: SESSION_PROTOCOL,
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
  const modulePath = join(RUNTIME_ROOT, 'desktop-service-clients.mjs');
  writeFileSync(modulePath, `
    export async function createDesktopService({ onClientCountChanged }) {
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
  const service = createSessionService({
    createSessionRuntime: async () => createStubSessionRuntime(),
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

function createStubSessionRuntime(sessionId = '') {
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
    async submitAsync(text) {
      state = { ...state, items: [...state.items, { id: state.items.length + 1, text: String(text) }] };
      publish();
      return true;
    },
    async resume(id) {
      state = { ...state, sessionId: String(id), items: [{ id: 1, text: `resumed ${id}` }] };
      publish();
      return true;
    },
    setProgressHint() {
      state = { ...state, busy: true, items: [...state.items, { id: state.items.length + 1, text: 'working' }] };
      publish();
      return true;
    },
    setCwd(cwd) {
      state = { ...state, cwd: String(cwd) };
      publish();
      return state.cwd;
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
    getProfile() { throw new Error('stub failure'); },
    // A function value must never cross the wire — the sanitizer drops it.
    getTheme() { return { ok: true, callback() {}, when: new Date(0) }; },
    async dispose() { state = { ...state, disposed: true }; publish(); },
  };
}

test('canonical session.read returns raw agent messages without a deprecated action', async () => {
  const messages = [
    { role: 'user', content: 'worker brief' },
    { role: 'assistant', content: 'worker handoff' },
  ];
  const runtime = createStubSessionRuntime('agent_read_session');
  assert.equal(Object.hasOwn(runtime, 'session'), false);
  const service = createSessionService({
    createSessionRuntime: async () => runtime,
    readStoredSession: async (_sessionId, options = {}) => ({
      items: [],
      ...(options.includeMessages === true ? { messages } : {}),
    }),
  });
  try {
    const result = await service.handleCall('session.read', {
      sessionId: 'agent_read_session',
      messageStart: 1,
    });
    assert.equal(result.messageCount, 2);
    assert.deepEqual(result.messages, [messages[1]]);
    assert.equal(SESSION_READ_ACTIONS.some((name) => /peek/i.test(name)), false);
  } finally {
    await service.stop('test end');
  }
});

async function withDaemon(run, {
  sessionFactory = async () => createStubSessionRuntime(), idleEvictMs = null, evictSweepMs = null,
  onClientRegistered = null, softRssMb = null,
  rssBytes = undefined, desktopRuntime = null,
} = {}) {
  let clientsEmptyReason = null;
  // Client identity is what the pool refcounts views by; the tests need it to
  // act as "that client went away" without tearing down the local view.
  let lastClientToken = null;
  const service = createSessionService({
    createSessionRuntime: sessionFactory,
    publishIntervalMs: 5,
    onFrame: (frame, targetTokens) => transport.broadcast(frame, targetTokens),
    idleEvictMs,
    evictSweepMs,
    softRssMb,
    desktopRuntime,
    ...(rssBytes ? { rssBytes } : {}),
  });
  const transport = createSessionTransport({
    handleCall: (name, args, ctx) => {
      if (ctx?.clientToken) lastClientToken = ctx.clientToken;
      return service.handleCall(name, args, ctx);
    },
    clientGraceMs: 50,
    sweepMs: 50,
    onClientsEmpty: () => { clientsEmptyReason = 'empty'; },
    onClientRegistered,
    onClientDropped: (token) => { service.releaseClient(token); },
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  writeFileSync(join(RUNTIME_ROOT, 'daemon.json'), JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    endpoints: { session: { port, token } },
  }));
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

test('the first runtime client can start runtime prewarm before creating a session', async () => {
  const registrations = [];
  await withDaemon(async ({ discovery, service }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
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
      protocol: SESSION_PROTOCOL,
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
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const work = Promise.all(Array.from({ length: 64 }, (_, index) =>
      client.call('session.read', {
        sessionId,
        action: 'getTheme',
        args: [index],
      }, { callId: `control-plane-work:${index}` })));
    await new Promise((resolve) => setImmediate(resolve));

    let newcomer = null;
    try {
      const started = performance.now();
      newcomer = await attachSession({ discovery, cwd: process.cwd() });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 100, `registration waited ${elapsed.toFixed(1)}ms behind session calls`);
    } finally {
      await newcomer?.close('control-plane test');
      await work;
      await client.close('control-plane test');
    }
  }, {
    sessionFactory: async () => ({
      ...createStubSessionRuntime(),
      getTheme(index) {
        const deadline = performance.now() + 5;
        while (performance.now() < deadline) { /* deliberate synchronous slice */ }
        return index;
      },
    }),
  });
});

test('session submit ACK does not wait for auto-clear and remains reclaimable', async () => {
  const clearGate = Promise.withResolvers();
  let enqueued = 0;
  const queued = [];
  let state = { busy: false, commandBusy: false };
  const api = createSessionApiA({
    runtime: { abort: () => true },
    nextId: () => 'generated-id',
    flags: {},
    pending: [],
    listeners: new Set(),
    getState: () => state,
    getPublishedState: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    routeState: () => ({}),
    autoClearBeforeSubmit: () => clearGate.promise,
    enqueue: (text, options) => {
      enqueued += 1;
      queued.push({ text, id: options.id });
      return true;
    },
    restoreQueued: (_current, selectedId) => {
      const index = queued.findIndex((entry) => entry.id === selectedId);
      if (index < 0) return {
        count: 0, ids: [], text: '', pastedImages: null, pastedTexts: null,
      };
      const [entry] = queued.splice(index, 1);
      return {
        count: 1,
        ids: [entry.id],
        text: entry.text,
        pastedImages: null,
        pastedTexts: null,
      };
    },
  });

  const submitting = api.submitAsync('recover before busy', {
    id: 'actual-session-idle-1',
  });
  assert.equal(await submitting, true, 'queue intake ACKs before compaction settles');
  assert.equal(enqueued, 1);
  const restored = api.abort({
    restorePrompt: true,
    submissionId: 'actual-session-idle-1',
  });
  assert.equal(restored.aborted, false);
  assert.equal(restored.restoreText, 'recover before busy');
  assert.deepEqual(restored.restoredSubmissionIds, ['actual-session-idle-1']);

  clearGate.resolve();
  assert.equal(queued.length, 0, 'targeted abort reclaims the acknowledged queue entry');
});

test('persisted steering keeps the desktop submission identity across recovery', async () => {
  const sessionId = `steering-recovery-${Date.now()}`;
  const entry = {
    id: 'desktop-submit-retry-1',
    text: 'ship it',
    submittedAt: Date.now() - 50,
  };
  await appendTuiSteeringPersist(sessionId, entry);
  const restored = await drainTuiSteeringPersist(sessionId);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].text, entry.text);
  assert.equal(restored[0].submissionId, entry.id);
  assert.equal(restored[0].submittedAt, entry.submittedAt);
});

test('process-restart resume restores queued steering before releasing commandBusy', async () => {
  const restoreStarted = Promise.withResolvers();
  const restoreGate = Promise.withResolvers();
  let restored = false;
  let sequence = 0;
  let state = { commandBusy: false, stats: {} };
  const releaseStates = [];
  const api = createSessionApiB({
    runtime: {
      resume: async (id) => ({ id, messages: [] }),
    },
    nextId: () => `resume-item-${++sequence}`,
    flags: {},
    lifecycle: {},
    listeners: new Set(),
    getState: () => state,
    set: (patch) => {
      if (patch.commandBusy === false) releaseStates.push(restored);
      state = { ...state, ...patch };
    },
    flushEmitImmediate: () => {},
    replaceItems: (items) => items,
    clearToastTimers: () => {},
    routeState: () => ({}),
    resetStatsAndSyncContext: () => state.stats,
    restoreLeadSteeringFromDisk: () => {
      restoreStarted.resolve();
      return restoreGate.promise.then(() => { restored = true; });
    },
  });

  let settled = false;
  const resuming = api.resume('restart-session', { quiet: true }).then((value) => {
    settled = true;
    return value;
  });
  await restoreStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.commandBusy, true);
  assert.equal(settled, false, 'resume must keep the command gate until steering is durable in memory');

  restoreGate.resolve();
  assert.equal(await resuming, true);
  assert.equal(state.commandBusy, false);
  assert.deepEqual(releaseStates, [true], 'the release-triggered drain must see restored steering');
});

test('abort starts immediately while ordinary session calls remain in flight', async () => {
  let releaseWork;
  let startedWork = 0;
  let abortCalls = 0;
  let abortOptions = null;
  const workGate = new Promise((resolve) => { releaseWork = resolve; });
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const work = Array.from({ length: 64 }, (_, index) =>
      client.call('session.read', {
        sessionId,
        action: 'getSettingsSnapshot',
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
        options: { restorePrompt: false, submissionId: 'desktop-submit-1' },
      }, {
        callId: 'reserved-capacity-abort',
      });
      const elapsed = performance.now() - started;
      assert.equal(result.aborted, true);
      assert.equal(result.restoreText, 'queued prompt');
      assert.deepEqual(result.pastedTexts, { text_1: { text: 'restored text' } });
      assert.deepEqual(abortOptions, {
        restorePrompt: false,
        submissionId: 'desktop-submit-1',
      });
      assert.equal(abortCalls, 1);
      assert.ok(elapsed < 100, `abort waited ${elapsed.toFixed(1)}ms behind ordinary calls`);
    } finally {
      releaseWork();
      await Promise.all(work);
      await client.close('reserved capacity test');
    }
  }, {
    sessionFactory: async () => ({
      ...createStubSessionRuntime(),
      getSettingsSnapshot() {
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
    const noisy = await attachSession({
      discovery, cwd: process.cwd(), leadPid: process.pid,
    });
    const victim = await attachSession({
      discovery, cwd: process.cwd(), leadPid: process.ppid,
    });
    const { sessionId } = await noisy.call('session.create', { cwd: process.cwd() });
    const noisyWork = Array.from({ length: 60 }, (_, index) =>
      noisy.call('session.read', {
        sessionId,
        action: 'getProfile',
        args: [`noisy-${index}`],
      }, { callId: `fair-noisy-${index}` }));
    let victimWork = null;
    try {
      await waitFor(
        () => started.length === noisyWork.length,
        'noisy session starts its full parallel wave',
      );
      victimWork = victim.call('session.read', {
        sessionId,
        action: 'getProfile',
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
    sessionFactory: async () => ({
      ...createStubSessionRuntime(),
      getProfile(label) {
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
  const transport = createChannelTransport({
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
      leadPid: process.pid, cwd: process.cwd(), passive: true,
    });
    const victim = await daemonPost(discovery, '/client/register', {
      leadPid: process.ppid, cwd: process.cwd(), passive: true,
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

test('disconnected channel remote-state churn keeps only the latest frame', async () => {
  const transport = createChannelTransport({
    handleCall: async () => ({ ok: true }),
  });
  const endpoint = await transport.start();
  try {
    const registered = await daemonPost(endpoint, '/client/register', {
      leadPid: process.pid,
      cwd: process.cwd(),
      passive: true,
    });
    const client = transport._clientsForTest.get(registered.token);
    assert.ok(client);
    for (let index = 0; index < 10_000; index += 1) {
      transport._writeRemoteStateToForTest(client, `state-${index}`);
    }
    assert.equal(typeof client.pendingRemoteStateFrame, 'string');
    assert.equal(JSON.parse(client.pendingRemoteStateFrame).params.state, 'state-9999');
    assert.equal(Object.hasOwn(client, 'pending'), false);
  } finally {
    await transport.stop();
  }
});

test('channel transport publishes the pinned remote session independently of state-file persistence', async () => {
  const states = [];
  let transport = null;
  transport = createChannelTransport({
    handleCall: async (name, args) => {
      if (name === 'activate_channel_bridge' && args.active === true) {
        transport.notify('notifications/mixdog/remote', { state: 'acquired' });
      }
      return { ok: true };
    },
    onRemoteStateChange: (state) => states.push(state),
  });
  const endpoint = await transport.start();
  try {
    const registered = await daemonPost(endpoint, '/client/register', {
      leadPid: process.pid,
      cwd: process.cwd(),
      passive: true,
    });
    await daemonPost(endpoint, '/call', {
      token: registered.token,
      name: 'activate_channel_bridge',
      args: { active: true, sessionId: 'session_remote' },
    });
    assert.equal(states.at(-1)?.enabled, true);
    assert.equal(states.at(-1)?.sessionId, 'session_remote');

    await daemonPost(endpoint, '/call', {
      token: registered.token,
      name: 'activate_channel_bridge',
      args: { active: false, sessionId: 'session_remote' },
    });
    assert.equal(states.at(-1)?.enabled, false);
    assert.equal(states.at(-1)?.sessionId, null);
  } finally {
    await transport.stop();
  }
});

test('call idempotency is isolated per client process', async () => {
  await withDaemon(async ({ discovery }) => {
    const first = await attachSession({
      discovery, cwd: process.cwd(), leadPid: process.pid,
    });
    const second = await attachSession({
      discovery, cwd: process.cwd(), leadPid: process.ppid,
    });
    const { sessionId } = await first.call('session.create', { cwd: process.cwd() });
    const args = { sessionId, prompt: 'same payload' };
    await first.call('session.submit', args, { callId: 'same-process-local-id' });
    await second.call('session.submit', args, { callId: 'same-process-local-id' });
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
    const terminal = await attachSession({
      discovery, cwd: process.cwd(), onFrame: (frame) => terminalFrames.push(frame),
    });
    const desktop = await attachSession({
      discovery, cwd: process.cwd(), onFrame: (frame) => desktopFrames.push(frame),
    });
    const unrelated = await attachSession({
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
    const external = await attachSession({ discovery, cwd: process.cwd() });
    const internal = await attachSession({
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
  const sessionFactory = async () => {
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
      async submitAsync(text) {
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
    const terminal = await attachSession({
      discovery,
      cwd: process.cwd(),
      onFrame: (frame) => terminalFrames.push(frame),
    });
    const desktop = await attachSession({ discovery, cwd: process.cwd() });
    const created = await terminal.call('session.create', { cwd: process.cwd() });
    assert.match(created.sessionId, /^sess_daemon_/, 'create returns a daemon-reserved stable address');
    assert.ok(created.revision > 1_000_000_000_000,
      'default daemon revisions carry a restart-monotonic epoch');
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
    assert.equal(service.size, 1, 'the daemon still owns the session runtime');

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
  }, { sessionFactory });
});

test('session faults answer as call errors and non-serializable values are dropped', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    await assert.rejects(
      () => client.call('session.read', { sessionId, action: 'getProfile', args: [] }),
      /stub failure/,
    );
    await assert.rejects(
      () => client.call('session.read', { sessionId, action: 'getOutputStyle', args: [] }),
      /unavailable/,
    );
    const described = await client.call('session.read', { sessionId, action: 'getTheme', args: [] });
    assert.deepEqual(described.value, { ok: true, when: '1970-01-01T00:00:00.000Z' });
    await client.close('test');
  });
});

test('an addressed session action cannot silently move to another id', async () => {
  const sessionFactory = async () => {
    let state = { sessionId: '', items: [], queued: [], busy: false };
    const listeners = new Set();
    const publish = () => {
      for (const listener of [...listeners]) listener();
    };
    return {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reserveSession(id) {
        state = { ...state, sessionId: String(id) };
        publish();
        return true;
      },
      setRoute() {
        state = { ...state, sessionId: 'silently-rebound-session' };
        publish();
        return true;
      },
      async dispose() {},
    };
  };

  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const created = await client.call('session.create', {
      sessionId: 'addressed-session',
      cwd: process.cwd(),
    });
    assert.equal(created.sessionId, 'addressed-session');
    await assert.rejects(
      () => client.call('session.configure', {
        sessionId: created.sessionId,
        action: 'setRoute',
        args: [{ model: 'test-model', applyToCurrentSession: true }],
      }),
      /session addressed-session changed its durable address to silently-rebound-session/,
    );
    await client.close('address invariant verified');
  }, { sessionFactory });
});

test('a retried call with the same id runs exactly one runtime mutation', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const callId = 'stable-call-id';
    await client.call('session.submit', { sessionId, prompt: 'once' }, { callId });
    await client.call('session.submit', { sessionId, prompt: 'once' }, { callId });
    const read = await client.call('session.read', { sessionId });
    assert.equal(read.full.items.length, 1);
    await client.close('test');
  });
});

test('replay-safe session reads do not retain snapshots in the mutation cache', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const before = await probeSessionHealth(discovery);
    for (let index = 0; index < 20; index += 1) {
      await client.call('session.read', { sessionId }, { callId: `snapshot-read:${index}` });
    }
    const after = await probeSessionHealth(discovery);
    assert.equal(
      after?.transportMemory?.callCacheEntries,
      before?.transportMemory?.callCacheEntries,
    );
    await client.close('read cache verified');
  });
});

test('the remote session projection keeps the store contract', async () => {
  await withDaemon(async () => {
    const runtime = await createSession({ cwd: process.cwd() });
    assert.equal(runtime.isRemoteSession, true);
    assert.match(runtime.getState().sessionId, /^sess_daemon_/);

    let notified = 0;
    const unsubscribe = runtime.subscribe(() => { notified += 1; });
    assert.equal(await runtime.submit('through the proxy'), true);
    await waitFor(() => runtime.getState().items?.length === 1, 'proxy mirrors its own submission');
    assert.ok(notified > 0, 'subscribers observe the mirrored snapshot');
    await runtime.setProgressHint('working');
    const preserved = await runtime.abortAsync({ restorePrompt: false });
    assert.equal(preserved.aborted, true);
    assert.equal(preserved.restoreText, '', 'a replacement draft suppresses prompt rewind across the daemon');
    assert.equal(preserved.pastedImages, null);
    await runtime.setProgressHint('working');
    const interrupted = await runtime.abortAsync();
    assert.equal(interrupted.aborted, true);
    assert.equal(interrupted.restoreText, 'restored prompt');
    assert.deepEqual(interrupted.pastedImages, { image_1: { filename: 'restored.png' } });
    assert.equal(runtime.getState().busy, false);
    unsubscribe();

    // Revisions are local to a session projection. This old session has
    // advanced farther than the fresh reservation, but New task must still
    // replace its transcript from the lower-numbered full baseline.
    const previousSessionId = runtime.getState().sessionId;
    await runtime.newSession();
    assert.notEqual(runtime.getState().sessionId, previousSessionId);
    assert.deepEqual(runtime.getState().items, [],
      'a fresh New task never retains the previous session transcript');

    // A second view shares the process attachment but owns another session.
    const second = await createSession({ cwd: process.cwd() });
    assert.notEqual(second.getState().sessionId, runtime.getState().sessionId);
    await second.dispose('test');
    await runtime.dispose('test');
  });
});

test('the remote TUI project surface uses only daemon project and cwd routes', async () => {
  const rows = [{ name: 'Shared', path: 'C:\\shared' }];
  const touched = [];
  const projectStore = {
    listProjects: () => rows,
    addProject: (path) => {
      const project = { name: 'Added', path };
      rows.push(project);
      return project;
    },
    touchProjectSelected: (path) => {
      touched.push(path);
      return rows.find((row) => row.path === path) || null;
    },
  };
  await withDaemon(async () => {
    const runtime = await createSession({ cwd: 'C:\\initial' });
    assert.deepEqual(await runtime.listProjects(), rows);
    assert.deepEqual(await runtime.addProject('C:\\added'), {
      name: 'Added',
      path: 'C:\\added',
    });
    assert.equal(await runtime.setCwd('C:\\shared'), 'C:\\shared');
    assert.equal(runtime.getState().cwd, 'C:\\shared');
    assert.equal(typeof runtime.getState().cwd, 'string');
    assert.deepEqual(touched, ['C:\\shared']);
    await runtime.dispose('test');
  }, {
    desktopRuntime: { loadProjects: async () => projectStore },
  });
});

test('the daemon signals shutdown once the last view leaves', async () => {
  await withDaemon(async ({ discovery, clientsEmpty }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    await client.call('session.create', { cwd: process.cwd() });
    await client.close('test');
    await waitFor(() => clientsEmpty() === 'empty', 'client grace elapses into shutdown');
  });
});

test('resuming a session another view already holds converges on one owner', async () => {
  await withDaemon(async ({ service }) => {
    const terminal = await createSession({ cwd: process.cwd() });
    const desktop = await createSession({ cwd: process.cwd() });
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
      'the terminal view sees the desktop edit on the shared runtime');

    await terminal.submit('typed in the terminal');
    await waitFor(() => desktop.getState().items.some((item) => item.text === 'typed in the terminal'),
      'the desktop view sees the terminal edit on the shared runtime');

    await desktop.dispose('test');
    await terminal.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('a method return leaves the view consistent immediately', async () => {
  await withDaemon(async () => {
    const view = await createSession({ cwd: process.cwd() });
    // No await on a frame: the session projection is consistent the instant
    // the method returns.
    await view.resume('immediate-session');
    assert.equal(view.getState().sessionId, 'immediate-session');
    // submit is part of the SYNCHRONOUS store surface: it accepts inline and
    // the transcript follows, exactly like the in-process store.
    assert.equal(view.submit('immediate'), true);
    await waitFor(() => view.getState().items.at(-1)?.text === 'immediate',
      'the submitted item lands in the view');
    await view.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('a working runtime outlives its last view and the next one rejoins it', async () => {
  await withDaemon(async ({ service }) => {
    const before = await createSession({ cwd: process.cwd() });
    await before.resume('long-running');
    await before.setProgressHint('working');
    assert.equal(before.getState().busy, true, 'the runtime is mid-turn');

    // The app quits / the terminal is restarted while the turn runs.
    await before.dispose('app restart');
    assert.equal(service.size, 1, 'the daemon keeps running the turn with no views attached');

    // The client comes back and resumes the same session.
    const after = await createSession({ cwd: process.cwd() });
    await after.resume('long-running');
    assert.equal(after.getState().busy, true, 'the returning view rejoins the live turn');
    assert.ok(after.getState().items.some((item) => item.text === 'working'),
      'the transcript produced while nobody watched is still there');
    assert.equal(service.size, 1, 'no second runtime was created for the same session');

    await after.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('an unwatched runtime retains its CC-style background task until completion', async () => {
  const taskId = `session-retention-shell-${Date.now()}`;
  let ownerSessionId = '';
  let cancelled = 0;
  try {
    await withDaemon(async ({ discovery, service }) => {
      const client = await attachSession({ discovery, cwd: process.cwd() });
      try {
        const created = await client.call('session.create', { cwd: process.cwd() });
        ownerSessionId = created.sessionId;
        registerBackgroundTask({
          taskId,
          surface: 'shell',
          operation: 'shell',
          label: 'retained shell task',
          context: { callerSessionId: ownerSessionId },
          cancel: () => { cancelled += 1; },
        });
        await client.call('session.unsubscribe', { sessionId: ownerSessionId });

        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(service.size, 1, 'idle eviction must not cancel owner background work');
        assert.equal(service.busyCount, 1, 'daemon shutdown guard sees background work');
        assert.equal(service.status.busy, 1, 'session status reports background work');
        assert.equal(getBackgroundTask(taskId)?.status, 'running');

        completeBackgroundTask(taskId, {
          status: 'completed',
          resultText: 'retained completion',
          notify: false,
        });
        await waitFor(
          () => service.size === 0,
          'the runtime is reclaimed only after its background task completes',
        );
        assert.equal(cancelled, 0, 'idle eviction never owns task cancellation');
      } finally {
        await client.close('background retention test');
      }
    }, {
      idleEvictMs: 15,
      evictSweepMs: 5,
      sessionFactory: async () => createStubSessionRuntime(''),
    });
  } finally {
    cleanupBackgroundTasks({
      force: true,
      callerSessionId: ownerSessionId,
      surface: 'shell',
    });
  }
});

test('auto-background task elapsed time includes its foreground phase', () => {
  const taskId = `shell-total-elapsed-${Date.now()}`;
  const startedAtMs = Date.now() - 16_000;
  const task = registerBackgroundTask({
    taskId,
    startedAtMs,
    surface: 'shell',
    operation: 'shell',
    label: 'foreground then background',
  });
  assert.equal(task.startedAtMs, startedAtMs);
  assert.equal(Date.parse(task.startedAt), startedAtMs);
  completeBackgroundTask(taskId, {
    status: 'completed',
    resultText: 'done',
    notify: false,
  });
  cleanupBackgroundTasks({ force: true, surface: 'shell' });
});

test('session retention exposes no RSS growth ceiling', async () => {
  await withDaemon(async ({ service }) => {
    assert.equal(Object.hasOwn(service.status, 'softRssBytes'), false);
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('repeated idle session churn releases runtimes, projections, and its sweep timer', async () => {
  const rounds = 6;
  const sessionsPerRound = 24;
  const payloadChars = 256 * 1024;
  let disposed = 0;
  const heapSamples = [];

  await withDaemon(async ({ discovery, service }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    try {
      for (let round = 0; round < rounds; round += 1) {
        const ids = [];
        for (let index = 0; index < sessionsPerRound; index += 1) {
          const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
          ids.push(sessionId);
          await client.call('session.submit', {
            sessionId,
            prompt: `${round}:${index}:${'x'.repeat(payloadChars)}`,
          });
        }
        await Promise.all(ids.map((sessionId) =>
          client.call('session.unsubscribe', { sessionId })));
        const expectedDisposed = (round + 1) * sessionsPerRound;
        await waitFor(
          () => service.size === 0 && disposed === expectedDisposed,
          () => `idle churn retained ${service.size} runtime(s), disposed=${disposed}/${expectedDisposed}`,
        );
        assert.deepEqual(service.status, {
          live: 0,
          busy: 0,
          watched: 0,
          retained: 0,
          projected: 0,
          pendingViewerSessions: 0,
          evictionSweepActive: false,
        });
        if (global.gc) {
          global.gc();
          global.gc();
          await new Promise((resolve) => setImmediate(resolve));
          heapSamples.push(process.memoryUsage().heapUsed);
        }
      }
    } finally {
      await client.close('memory churn test');
    }
  }, {
    idleEvictMs: 15,
    evictSweepMs: 5,
    sessionFactory: async () => {
      const runtime = createStubSessionRuntime('');
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async (...args) => {
        disposed += 1;
        return dispose(...args);
      };
      return runtime;
    },
  });

  if (heapSamples.length > 1) {
    const growth = heapSamples.at(-1) - heapSamples[0];
    assert.ok(growth < 24 * 1024 * 1024,
      `heap grew ${(growth / 1024 / 1024).toFixed(1)}MB across reclaimed churn`);
  }
});

test('one client leaving never ends the runtime another client is watching', async () => {
  await withDaemon(async ({ discovery, service }) => {
    // Two SEPARATE clients (terminal process + desktop process), not two views
    // in one process: the mirror refcount inside a client cannot see the peer.
    const terminal = await attachSession({ discovery, cwd: process.cwd() });
    const desktop = await attachSession({
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
    assert.equal(service.size, 1, 'a session-carrying runtime outlives every view');

    await desktop.close('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('a client that disappears releases its view without killing the runtime', async () => {
  await withDaemon(async ({ discovery, service }) => {
    const terminal = await attachSession({ discovery, cwd: process.cwd() });
    const desktop = await attachSession({ discovery, cwd: process.cwd() });
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
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('closing every view never ends a live session runtime', async () => {
  await withDaemon(async ({ service }) => {
    const terminal = await createSession({ cwd: process.cwd() });
    await terminal.resume('kept-alive');
    await terminal.submit('half of a conversation');
    await waitFor(() => terminal.getState().items.length === 2, 'the session has content');

    // Idle, not busy, nobody watching — the old contract destroyed it here and
    // that is what cut a turn short when the other surface was still using it.
    await terminal.dispose('terminal exit');
    assert.equal(service.size, 1, 'the runtime belongs to the daemon, not to the view');

    // Coming back rejoins the SAME live runtime, in-memory state intact.
    const desktop = await createSession({ cwd: process.cwd() });
    await desktop.resume('kept-alive');
    assert.equal(service.size, 1, 'no second runtime was loaded for the session');
    assert.ok(desktop.getState().items.some((item) => item.text === 'half of a conversation'),
      'the returning view sees the live transcript, not a disk reload');
    await desktop.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('a view told its session was unloaded comes back instead of stalling', async () => {
  await withDaemon(async ({ transport, service }) => {
    const view = await createSession({ cwd: process.cwd() });
    await view.resume('recovered-session');
    // The daemon announces an idle unload. The projection must subscribe again
    // without exposing or recovering an internal runtime handle.
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
      'a prompt sent after the recovery still reaches the runtime');

    await view.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});
test('a silent SSE is reconnected and a continuous reconnect storm exhausts its budget', async () => {
  const serverToken = 'server-token';
  const clientToken = 'client-token';
  const fatals = [];
  const disconnects = [];
  let eventRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      send({ status: 'ok', pid: process.pid });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      eventRequests += 1;
      if (eventRequests === 1) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        });
        res.write(': attached\n\n');
      } else {
        send({ error: 'temporary stream failure' }, 503);
      }
      return;
    }
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/client/register') {
        send({ token: clientToken, pid: process.pid });
      } else if (req.method === 'POST' && url.pathname === '/client/deregister') {
        send({ ok: true });
      } else {
        send({ error: 'not found' }, 404);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  let client = null;
  try {
    client = await attachSession({
      discovery: { port: address.port, token: serverToken, pid: process.pid },
      onFatal: (reason) => fatals.push(reason),
      onStreamDisconnect: (details) => disconnects.push(details),
      streamReconnectBaseMs: 5,
      streamReconnectMaxMs: 10,
      streamLivenessTimeoutMs: 20,
      streamReconnectBudgetMs: 60,
    });
    await waitForValue(() => fatals.length === 1);
    assert.match(disconnects[0]?.reason || '', /sse liveness timeout after 20ms/);
    assert.match(fatals[0], /reconnect budget exhausted/);
    assert.ok(eventRequests >= 2, 'liveness timeout must open a replacement stream');
  } finally {
    await client?.close('test end');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reusing a mutation callId with a different payload fails closed', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const callId = 'conflicting-call-id';
    await client.call('session.submit', { sessionId, prompt: 'first' }, { callId });
    await assert.rejects(
      () => client.call('session.submit', { sessionId, prompt: 'second' }, { callId }),
      /reused with a different payload/,
    );
    const read = await client.call('session.read', { sessionId });
    assert.equal(read.full.items.length, 1);
    assert.equal(read.full.items[0].text, 'first');
    await client.close('call conflict verified');
  });
});
