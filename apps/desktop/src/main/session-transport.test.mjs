import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SessionHost } from './session-host.ts';
import { SessionTransport } from './session-transport.ts';

const options = {
  userDataPath: 'C:/tmp/mixdog',
  packaged: true,
  resourcesPath: 'C:/tmp/resources',
  appPath: 'C:/tmp/resources/app.asar',
};

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('failed desktop initialization closes its daemon attachment and preserves the cause', async () => {
  let closeCalls = 0;
  const calls = [];
  const failure = new Error('plain Node could not import the desktop service');
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
      attachSession: async () => ({
        async call(name) {
          calls.push(name);
          if (name === 'desktop.init') throw failure;
          return { ok: true };
        },
        async close() { closeCalls += 1; },
      }),
    }),
  );
  let exit = null;
  transport.on('exit', (code, cause) => { exit = { code, cause }; });
  transport.postMessage({ kind: 'init', options });

  await waitFor(() => exit);
  assert.equal(exit.code, 1);
  assert.equal(exit.cause, failure);
  assert.equal(closeCalls, 1);
  assert.deepEqual(calls, ['desktop.init', 'desktop.unsubscribe']);
});

test('a mismatched session contract tells desktop users how to recover', async () => {
  const conflict = Object.assign(
    new Error('session protocol mismatch'),
    { sessionProtocolMismatch: true },
  );
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => { throw conflict; },
      attachSession: async () => { throw new Error('must not attach'); },
    }),
  );
  let exit = null;
  transport.on('exit', (code, cause) => { exit = { code, cause }; });
  transport.postMessage({ kind: 'init', options });

  await waitFor(() => exit);
  assert.equal(exit.code, 1);
  assert.match(exit.cause.message, /different Mixdog session contract is already running/i);
  assert.match(exit.cause.message, /close every Mixdog window and terminal/i);
  assert.equal(exit.cause.cause, conflict);
});

test('a transient pooled-socket reset retries one desktop request with the same call id', async () => {
  const invocations = [];
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
      attachSession: async () => ({
        async call(name, args, callOptions) {
          if (name === 'desktop.init') return { desktopId: 'desktop_test' };
          if (name === 'desktop.control') return { ok: true };
          if (name === 'desktop.invoke') {
            invocations.push({ args, callId: callOptions?.callId });
            if (invocations.length === 1) {
              throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
            }
            return 'recovered';
          }
          return { ok: true };
        },
        async close() {},
      }),
    }),
  );
  const messages = [];
  transport.on('message', (message) => messages.push(message));
  transport.postMessage({ kind: 'init', options });
  await waitFor(() => messages.some((message) => message.kind === 'ready'));
  transport.postMessage({
    kind: 'request',
    id: 42,
    method: 'getProviderSetup',
    args: [],
  });
  const response = await waitFor(() => messages.find((message) =>
    message.kind === 'response' && message.id === 42));
  assert.equal(response.ok, true);
  assert.equal(response.value, 'recovered');
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].callId, invocations[1].callId);
  assert.match(invocations[0].callId, /^desktop-invoke:/);
  await transport.close();
});

test('a dead daemon is reattached internally and replays an in-flight request once', async () => {
  const invocations = [];
  const diagnostics = [];
  const attachments = [];
  let ensureCount = 0;
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => ({
        pid: process.pid + ensureCount++,
        port: ensureCount,
        token: `test-${ensureCount}`,
      }),
      attachSession: async (attachOptions) => {
        const index = attachments.length;
        const client = {
          pid: process.pid + index,
          port: index + 1,
          async call(name, args, callOptions) {
            if (name === 'desktop.init') return { desktopId: 'desktop_recovered' };
            if (name === 'desktop.control') return { ok: true };
            if (name === 'desktop.invoke') {
              invocations.push({ index, args, callId: callOptions?.callId });
              if (index === 0) {
                attachOptions.onFatal?.('daemon exited pid=1 port=1');
                throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
                  code: 'ECONNREFUSED',
                  daemonTransportError: true,
                });
              }
              return 'reattached';
            }
            return { ok: true };
          },
          async close() {},
        };
        attachments.push(client);
        return client;
      },
    }),
  );
  const messages = [];
  let exit = null;
  transport.on('message', (message) => messages.push(message));
  transport.on('diagnostic', (event, details) => diagnostics.push({ event, details }));
  transport.on('exit', (code, cause) => { exit = { code, cause }; });
  transport.postMessage({ kind: 'init', options });
  await waitFor(() => messages.some((message) => message.kind === 'ready'));
  transport.postMessage({
    kind: 'request',
    id: 43,
    method: 'submit',
    args: ['preserve me'],
  });

  const response = await waitFor(() => messages.find((message) =>
    message.kind === 'response' && message.id === 43));
  assert.equal(response.ok, true);
  assert.equal(response.value, 'reattached');
  assert.equal(exit, null);
  assert.equal(attachments.length, 2);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].callId, invocations[1].callId);
  assert.deepEqual(
    diagnostics.map((entry) => entry.event),
    ['session-daemon-reconnecting', 'session-daemon-reconnected'],
  );
  await transport.close();
});

test('global capabilities recreate a stale service control session without exposing the failure', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'mixdog-session-host-'));
  let host = null;
  let hooks = null;
  let createCount = 0;
  const reads = [];
  const dead = new Set();
  const unsupported = async () => { throw new Error('unexpected session client call'); };
  const client = {
    list: unsupported,
    async create() {
      createCount += 1;
      const sessionId = `control_${createCount}`;
      return {
        sessionId,
        revision: 0,
        snapshot: { sessionId, items: [], queued: [] },
      };
    },
    async read({ sessionId }) {
      reads.push(sessionId);
      if (dead.has(sessionId)) throw new Error(`session ${sessionId} is not available`);
      return {
        sessionId,
        revision: 1,
        snapshot: { sessionId, items: [], queued: [] },
        value: { api: [], oauth: [], local: [] },
      };
    },
    subscribe: unsupported,
    unsubscribe: unsupported,
    submit: unsupported,
    abort: unsupported,
    approve: unsupported,
    configure: unsupported,
    async close() {},
  };
  try {
    host = await SessionHost.create({
      userDataPath,
      packaged: false,
      resourcesPath: userDataPath,
      appPath: userDataPath,
    }, {
      async attachSessionClient(nextHooks) {
        hooks = nextHooks;
        return client;
      },
      loadProjects: unsupported,
      loadSessionStore: unsupported,
      loadStatuslineSegments: unsupported,
      executeCodeGraphTool: unsupported,
    });

    await Promise.all([
      host.invokeCapability('getProviderSetup'),
      host.invokeCapability('getProviderSetup'),
      host.invokeCapability('getProviderSetup'),
    ]);
    dead.add('control_1');
    hooks.onFatal?.('test transport loss');
    await host.invokeCapability('getProviderSetup');
    dead.add('control_2');
    hooks.onFrame({ type: 'session-gone', sessionId: 'control_2' });
    await host.invokeCapability('getProviderSetup');
    dead.add('control_3');
    await host.invokeCapability('getProviderSetup');

    assert.equal(createCount, 4);
    assert.deepEqual(reads, [
      'control_1', 'control_1', 'control_1',
      'control_2', 'control_3', 'control_3', 'control_4',
    ]);
  } finally {
    await host?.dispose();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('an SSE reconnect resyncs in place without rejecting an in-flight desktop request', async () => {
  const calls = [];
  let streamDisconnect = null;
  let streamReconnect = null;
  let resolveInvoke;
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
      attachSession: async (attachOptions) => {
        streamDisconnect = attachOptions.onStreamDisconnect;
        streamReconnect = attachOptions.onStreamReconnect;
        return {
          async call(name, args) {
            calls.push({ name, args });
            if (name === 'desktop.init') return { desktopId: 'desktop_reconnect' };
            if (name === 'desktop.invoke') {
              return await new Promise((resolve) => { resolveInvoke = resolve; });
            }
            return { ok: true };
          },
          async close() {},
        };
      },
    }),
  );
  const messages = [];
  const diagnostics = [];
  let exit = null;
  transport.on('message', (message) => messages.push(message));
  transport.on('diagnostic', (event, details) => diagnostics.push({ event, details }));
  transport.on('exit', (code, cause) => { exit = { code, cause }; });
  transport.postMessage({ kind: 'init', options });
  await waitFor(() => messages.some((message) => message.kind === 'ready'));

  transport.postMessage({
    kind: 'request',
    id: 77,
    method: 'submit',
    args: ['preserve me'],
  });
  await waitFor(() => typeof resolveInvoke === 'function');
  streamDisconnect({ reason: 'sse ended' });
  streamReconnect({ reason: 'sse ended', attempt: 1, downtimeMs: 25 });
  await waitFor(() => calls.filter((entry) => entry.name === 'desktop.control').length === 2);
  resolveInvoke(true);
  const response = await waitFor(() => messages.find((message) =>
    message.kind === 'response' && message.id === 77));

  assert.equal(response.ok, true);
  assert.equal(response.value, true);
  assert.equal(exit, null, 'event-stream recovery does not restart the service transport');
  assert.deepEqual(
    diagnostics.map((entry) => entry.event),
    [
      'session-stream-reconnecting',
      'session-stream-reconnected',
      'session-stream-resync-complete',
    ],
  );
  await transport.close();
});

test('remote session ownership stays global when another session publishes focus state', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'mixdog-remote-owner-'));
  let host = null;
  let hooks = null;
  const updates = [];
  const unsupported = async () => { throw new Error('unexpected session client call'); };
  const client = {
    list: unsupported,
    create: unsupported,
    read: unsupported,
    async subscribe({ sessionId }) {
      return {
        sessionId,
        revision: 1,
        full: {
          sessionId,
          items: [],
          queued: [],
          remoteEnabled: false,
          remoteSessionId: null,
        },
      };
    },
    async unsubscribe() { return {}; },
    submit: unsupported,
    abort: unsupported,
    approve: unsupported,
    configure: unsupported,
    async close() {},
  };
  const latest = (sessionId) =>
    updates.filter((update) => update.sessionId === sessionId).at(-1)?.snapshot;
  try {
    host = await SessionHost.create({
      userDataPath,
      packaged: false,
      resourcesPath: userDataPath,
      appPath: userDataPath,
    }, {
      async attachSessionClient(nextHooks) {
        hooks = nextHooks;
        return client;
      },
      loadProjects: unsupported,
      loadSessionStore: unsupported,
      loadStatuslineSegments: unsupported,
      executeCodeGraphTool: unsupported,
    });
    host.subscribeSessionStates((update) => updates.push(update));
    await host.setVisibleSessions(['session_remote', 'session_focused']);

    hooks.onFrame({
      type: 'remote-owner-state',
      enabled: true,
      sessionId: 'session_remote',
    });
    assert.equal(latest('session_focused')?.remoteEnabled, true);
    assert.equal(latest('session_focused')?.remoteSessionId, 'session_remote');

    hooks.onFrame({
      type: 'session-state',
      sessionId: 'session_focused',
      revision: 2,
      full: {
        sessionId: 'session_focused',
        items: [],
        queued: [],
        remoteEnabled: false,
        remoteSessionId: null,
      },
    });
    assert.equal(latest('session_focused')?.remoteEnabled, true);
    assert.equal(latest('session_focused')?.remoteSessionId, 'session_remote');

    hooks.onFrame({
      type: 'remote-owner-state',
      enabled: false,
      sessionId: null,
    });
    assert.equal(latest('session_focused')?.remoteEnabled, false);
    assert.equal(latest('session_focused')?.remoteSessionId, null);
  } finally {
    await host?.dispose();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('new-task route trusts its authoritative result over a stale projected snapshot', async () => {
  const run = async (fastCapable) => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'mixdog-new-task-route-'));
    const sessionId = fastCapable ? 'session_fast' : 'session_no_fast';
    const actions = [];
    let host = null;
    let submitCalls = 0;
    let unsubscribeCalls = 0;
    const unsupported = async () => { throw new Error('unexpected session client call'); };
    const snapshot = (fast) => ({
      sessionId,
      items: [],
      queued: [],
      provider: 'openai-oauth',
      model: 'gpt-test',
      effort: 'high',
      fast,
    });
    const client = {
      async list() { return { sessions: [] }; },
      async create() {
        return { sessionId, revision: 0, full: snapshot(false) };
      },
      read: unsupported,
      subscribe: unsupported,
      async unsubscribe() {
        unsubscribeCalls += 1;
        return {};
      },
      async submit() {
        submitCalls += 1;
        return {
          sessionId,
          revision: 2,
          accepted: true,
          full: snapshot(true),
        };
      },
      abort: unsupported,
      approve: unsupported,
      async configure({ action, args }) {
        actions.push({ action, args });
        assert.equal(action, 'setRoute');
        const route = args[0];
        return {
          sessionId,
          revision: 1,
          value: { ...route, fast: route.fast === true && fastCapable },
          full: snapshot(false),
        };
      },
      async close() {},
    };
    try {
      host = await SessionHost.create({
        userDataPath,
        packaged: false,
        resourcesPath: userDataPath,
        appPath: userDataPath,
      }, {
        async attachSessionClient() { return client; },
        loadProjects: unsupported,
        async loadSessionStore() {
          return { listStoredAgentWorkers: () => [] };
        },
        loadStatuslineSegments: unsupported,
        executeCodeGraphTool: unsupported,
      });
      const promise = host.submitNewTask('route test', {}, {
        route: {
          provider: 'openai-oauth',
          model: 'gpt-test',
          effort: 'high',
          fast: true,
        },
      });
      if (fastCapable) {
        const result = await promise;
        assert.equal(result.accepted, true);
      } else {
        await assert.rejects(
          promise,
          /fast mode is not available for openai-oauth\/gpt-test/,
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
      return { actions, submitCalls, unsubscribeCalls };
    } finally {
      await host?.dispose();
      await rm(userDataPath, { recursive: true, force: true });
    }
  };

  const supported = await run(true);
  assert.deepEqual(supported.actions.map(({ action }) => action), ['setRoute']);
  assert.equal(supported.actions[0].args[0].fast, true);
  assert.equal(supported.submitCalls, 1);
  assert.equal(supported.unsubscribeCalls, 0);

  const unsupported = await run(false);
  assert.deepEqual(unsupported.actions.map(({ action }) => action), ['setRoute']);
  assert.equal(unsupported.submitCalls, 0);
  assert.equal(unsupported.unsubscribeCalls, 1);
});

test('a new task stays out of the session catalog until its first prompt is accepted', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'mixdog-new-task-catalog-'));
  const sessionId = 'first_prompt_catalog';
  const row = {
    id: sessionId,
    preview: 'catalog handoff',
    title: 'catalog handoff',
    updatedAt: Date.now(),
    lastUsedAt: Date.now(),
    messageCount: 1,
    cwd: join(userDataPath, 'workspace', 'unclassified'),
    desktopSession: { classification: 'task', projectPath: null },
  };
  let host;
  let submitStarted = false;
  let resolveSubmit;
  const submitResult = new Promise((resolve) => { resolveSubmit = resolve; });
  const unsupported = async () => { throw new Error('unsupported'); };
  const client = {
    async list() { return { sessions: [row] }; },
    async create() {
      return {
        sessionId,
        revision: 0,
        full: { sessionId, items: [], queued: [] },
      };
    },
    read: unsupported,
    subscribe: unsupported,
    async unsubscribe() { return {}; },
    async submit() {
      submitStarted = true;
      return submitResult;
    },
    abort: unsupported,
    approve: unsupported,
    configure: unsupported,
    async close() {},
  };
  try {
    host = await SessionHost.create({
      userDataPath,
      packaged: false,
      resourcesPath: userDataPath,
      appPath: userDataPath,
    }, {
      async attachSessionClient() { return client; },
      loadProjects: unsupported,
      async loadSessionStore() {
        return { listStoredAgentWorkers: () => [] };
      },
      loadStatuslineSegments: unsupported,
      executeCodeGraphTool: unsupported,
    });

    const submission = host.submitNewTask('catalog handoff');
    await waitFor(() => submitStarted);
    assert.deepEqual(await host.listSessions(), []);

    resolveSubmit({
      sessionId,
      revision: 1,
      accepted: true,
      full: { sessionId, items: [{ kind: 'user', text: 'catalog handoff' }], queued: [] },
    });
    assert.equal((await submission).accepted, true);
    assert.deepEqual((await host.listSessions()).map((session) => session.id), [sessionId]);
  } finally {
    await host?.dispose();
    await rm(userDataPath, { recursive: true, force: true });
  }
});
