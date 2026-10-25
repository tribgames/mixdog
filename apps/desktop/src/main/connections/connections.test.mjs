import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DESKTOP_IPC } from '../../shared/contract.ts';
import { waitUntil } from '../bounded-wait.mjs';
import { ipcErrorFromEnvelope } from '../../shared/coded-error.ts';
import { registerDesktopIpc } from '../ipc.ts';
import {
  REMOTE_ENSURE_TIMEOUT_MS,
  REMOTE_INSTALL_TIMEOUT_MS,
  REMOTE_PROBE_TIMEOUT_MS,
  RemoteBootstrapError,
} from '../ssh/remote-bootstrap.ts';
import { SshTargetError } from '../ssh/ssh-command.ts';
import {
  ConnectionPool,
  REMOTE_STARTUP_TIMEOUT_MS,
  REMOTE_TUNNEL_READY_TIMEOUT_MS,
  SSH_UNSUPPORTED_CHANNELS,
  WindowRouteRegistry,
  createConnectionIpcRouter,
  createConnectionManager,
  createConnectionWindowOpener,
  createDesktopConnection,
  createServiceTerminalHost,
  resolveWindowConnection,
} from './index.ts';

/** A daemon connection's service, recording what reached it. */
/** Adds `listener` to `set`; the returned function removes it. */
function subscribeTo(set, listener) {
  set.add(listener);
  return () => set.delete(listener);
}

function fakeService(label) {
  const listeners = { state: new Set(), sessions: new Set(), events: new Set() };
  const calls = [];
  return {
    label,
    calls,
    publishState: (snapshot) => {
      for (const listener of listeners.state) listener(snapshot);
    },
    publishSessions: (sessions) => {
      for (const listener of listeners.sessions) listener(sessions);
    },
    publishEvent: (name, value) => {
      for (const listener of listeners.events) listener({ name, value });
    },
    subscribe: (listener) => subscribeTo(listeners.state, listener),
    subscribeSessions: (listener) => subscribeTo(listeners.sessions, listener),
    subscribeSessionStates: () => () => {},
    subscribeDesktopEvents: (listener) => subscribeTo(listeners.events, listener),
    getSnapshot: () => ({ label }),
    listProjects: async () => [],
    listSessions: async () => {
      calls.push('listSessions');
      return [{ id: `${label}-session` }];
    },
    invokeDesktopOperation: async (method, args) => {
      calls.push(method);
      return { label, method, args };
    },
    notifyDesktopOperation: (method, args) => calls.push(`${method}:${JSON.stringify(args)}`),
  };
}

function fakeWindow(id) {
  const sent = [];
  const webContents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: {},
    isDestroyed: () => false,
    send: (channel, value) => sent.push([channel, value]),
  });
  return { window: { webContents, isDestroyed: () => false }, webContents, sent };
}

/** Two windows on two connections behind one real router, as main wires them. */
function twoConnectionFixture(t) {
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => {
    if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
    handlers.set(channel, handler);
  };
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  const pool = new ConnectionPool();
  const routes = new WindowRouteRegistry();
  const router = createConnectionIpcRouter({
    ipcMain,
    resolveSender: (sender) => resolveWindowConnection(routes, pool, sender.id),
  });
  const dialogCalls = [];
  // This PC's updater and notification sound; main hands them to its window only.
  const updaterListeners = new Set();
  const updater = {
    getState: () => ({ status: 'idle' }),
    subscribe: (listener) => subscribeTo(updaterListeners, listener),
    check: async () => ({ status: 'idle' }),
    install: async () => {},
    publish: (state) => {
      for (const listener of updaterListeners) listener(state);
    },
  };
  const open = (id, kind, webContentsId) => {
    const service = fakeService(id);
    pool.add({ id, kind, service });
    const view = fakeWindow(webContentsId);
    routes.register(view.webContents, id);
    const scope = router.scope(webContentsId, id);
    const remove = registerDesktopIpc(view.window, service, {
      app: { quit() {} },
      ipcMain: scope,
      dialog: {
        showOpenDialog: async () => {
          dialogCalls.push(id);
          return { canceled: true, filePaths: [] };
        },
        showMessageBox: async () => ({ response: 0 }),
      },
      shell: {
        openPath: async () => '',
        openExternal: async () => {},
        showItemInFolder() {},
        trashItem: async () => {},
      },
      connectionKind: kind,
      terminals: createServiceTerminalHost(service),
      ...(kind === 'ssh'
        ? { serviceUserDataPath: () => '/root/.mixdog-remote/user-data' }
        : { updater, previewNotificationSound: async () => 'played' }),
    });
    t.after(() => {
      remove();
      scope.dispose();
    });
    return { service, ...view };
  };
  const local = open('local', 'local', 1);
  const server = open('server-a', 'ssh', 2);
  const invoke = (webContents, channel, ...args) =>
    Promise.resolve().then(() =>
      handlers.get(channel)({ sender: webContents, senderFrame: webContents.mainFrame }, ...args)
    );
  const send = (webContents, channel, ...args) =>
    ipcMain.emit(channel, { sender: webContents, senderFrame: webContents.mainFrame }, ...args);
  return { handlers, ipcMain, pool, routes, local, server, invoke, send, dialogCalls, updater };
}

test('each window is answered by its own connection', async (t) => {
  const f = twoConnectionFixture(t);
  assert.deepEqual(await f.invoke(f.local.webContents, DESKTOP_IPC.listSessions), [{ id: 'local-session' }]);
  assert.deepEqual(await f.invoke(f.server.webContents, DESKTOP_IPC.listSessions), [{ id: 'server-a-session' }]);
  const status = await f.invoke(f.server.webContents, DESKTOP_IPC.gitStatus, '/srv/repo', {});
  assert.equal(status.label, 'server-a');
  assert.deepEqual(f.local.service.calls, ['listSessions']);
  assert.deepEqual(f.server.service.calls, ['listSessions', 'gitStatus']);
  // Fire-and-forget lanes route by sender too.
  f.send(f.server.webContents, DESKTOP_IPC.termWrite, 'term-1', 'ls\r');
  assert.deepEqual(f.server.service.calls.at(-1), 'termWrite:["term-1","ls\\r"]');
  assert.equal(f.local.service.calls.length, 1);
});

test('a window without a route or connection is refused, never served by this PC', async (t) => {
  const f = twoConnectionFixture(t);
  const stranger = fakeWindow(99).webContents;
  await assert.rejects(f.invoke(stranger, DESKTOP_IPC.listSessions), /connection-route-missing/);
  f.send(stranger, DESKTOP_IPC.termWrite, 'term-1', 'x');

  f.pool.remove('server-a');
  await assert.rejects(f.invoke(f.server.webContents, DESKTOP_IPC.listSessions), /connection-missing/);
  f.send(f.server.webContents, DESKTOP_IPC.termWrite, 'term-1', 'x');

  f.server.webContents.emit('destroyed');
  assert.equal(f.routes.connectionIdFor(2), undefined);
  await assert.rejects(f.invoke(f.server.webContents, DESKTOP_IPC.listSessions), /connection-route-missing/);
  assert.deepEqual(f.local.service.calls, [], 'the local connection never answers for another window');
  assert.deepEqual(f.server.service.calls, []);
  assert.throws(() => resolveWindowConnection(f.routes, f.pool, 99), /connection-route-missing/);
});

test('service events and snapshots reach only their connection windows', async (t) => {
  const f = twoConnectionFixture(t);
  const channels = (sent, channel) => sent.filter(([name]) => name === channel).map(([, value]) => value);
  f.server.service.publishSessions([{ id: 'remote' }]);
  f.local.service.publishSessions([{ id: 'here' }]);
  assert.deepEqual(channels(f.server.sent, DESKTOP_IPC.sessionsChanged), [[{ id: 'remote' }]]);
  assert.deepEqual(channels(f.local.sent, DESKTOP_IPC.sessionsChanged), [[{ id: 'here' }]]);

  f.server.service.publishState({ sessionId: 'remote', items: [] });
  assert.equal(channels(f.server.sent, DESKTOP_IPC.state).length, 1);
  assert.equal(channels(f.local.sent, DESKTOP_IPC.state).length, 0);

  f.server.service.publishEvent('terminal-data', { id: 'term-1', data: 'server output' });
  f.server.service.publishEvent('folder-changed', '/srv/repo');
  await waitUntil(
    () =>
      channels(f.server.sent, DESKTOP_IPC.termData).length > 0 &&
      channels(f.server.sent, DESKTOP_IPC.folderChanged).length > 0,
    'the server window to receive its terminal and folder events'
  );
  assert.deepEqual(
    channels(f.server.sent, DESKTOP_IPC.termData).map((event) => event.data),
    ['server output']
  );
  assert.deepEqual(channels(f.server.sent, DESKTOP_IPC.folderChanged), ['/srv/repo']);
  assert.equal(channels(f.local.sent, DESKTOP_IPC.termData).length, 0);
  assert.equal(channels(f.local.sent, DESKTOP_IPC.folderChanged).length, 0);
});

test('a server window refuses the features that act on this PC', async (t) => {
  const f = twoConnectionFixture(t);
  for (const channel of [
    DESKTOP_IPC.computerReadiness,
    DESKTOP_IPC.requestLinuxInputAccess,
    DESKTOP_IPC.browserPageFrame,
    DESKTOP_IPC.browserProfileImportSources,
    DESKTOP_IPC.remoteAccessInfo,
    DESKTOP_IPC.remotePairCode,
    DESKTOP_IPC.setRemoteAccessEnabled,
    DESKTOP_IPC.chooseFile,
    DESKTOP_IPC.openFilePath,
    DESKTOP_IPC.openProjectInExplorer,
    DESKTOP_IPC.revealFile,
  ]) {
    assert.ok(SSH_UNSUPPORTED_CHANNELS.has(channel), channel);
    await assert.rejects(f.invoke(f.server.webContents, channel, 'session-1'), /ssh-unsupported/, channel);
  }
  await assert.rejects(f.invoke(f.server.webContents, DESKTOP_IPC.chooseProject), /remote-picker-required/);
  assert.deepEqual(f.dialogCalls, [], 'no local dialog opens for a server window');
  // A server window's grants name server files only: this PC's never apply.
  const refused = ipcErrorFromEnvelope(
    await f.invoke(f.server.webContents, DESKTOP_IPC.readProjectFile, '/srv/repo', 'a.txt', 'token')
  );
  assert.equal(refused.code, 'SELECTED_FILE_GRANT_UNAVAILABLE');
  assert.match(refused.message, /selected-file permission is unavailable/);
  // Server paths stay POSIX paths when the daemon watches them.
  const watched = await f.invoke(f.server.webContents, DESKTOP_IPC.folderWatch, '/srv/repo/../repo', true);
  assert.deepEqual(watched.args, ['/srv/repo', true]);
  // The same features stay available to this PC's window.
  assert.equal(await f.invoke(f.local.webContents, DESKTOP_IPC.chooseProject), null);
  assert.deepEqual(f.dialogCalls, ['local']);
  await assert.rejects(f.invoke(f.local.webContents, DESKTOP_IPC.computerReadiness), /not available in this host/);
  assert.deepEqual(f.server.service.calls, ['folderWatch']);
});

test("the updater and the notification sound stay with this PC's window", async (t) => {
  const f = twoConnectionFixture(t);
  for (const channel of [
    DESKTOP_IPC.getUpdaterState,
    DESKTOP_IPC.checkForDesktopUpdate,
    DESKTOP_IPC.showDesktopUpdate,
    DESKTOP_IPC.previewNotificationSound,
  ]) {
    assert.ok(SSH_UNSUPPORTED_CHANNELS.has(channel), channel);
    await assert.rejects(f.invoke(f.server.webContents, channel), /ssh-unsupported/, channel);
  }
  assert.deepEqual(await f.invoke(f.local.webContents, DESKTOP_IPC.getUpdaterState), { status: 'idle' });
  assert.deepEqual(await f.invoke(f.local.webContents, DESKTOP_IPC.checkForDesktopUpdate), { status: 'idle' });
  assert.equal(await f.invoke(f.local.webContents, DESKTOP_IPC.previewNotificationSound), 'played');
  f.updater.publish({ status: 'ready', version: '9.9.9' });
  const updates = (sent) => sent.filter(([name]) => name === DESKTOP_IPC.updaterState).map(([, value]) => value);
  assert.deepEqual(updates(f.local.sent), [{ status: 'ready', version: '9.9.9' }]);
  assert.deepEqual(updates(f.server.sent), []);
  assert.deepEqual(f.server.service.calls, [], 'nothing reached the server daemon');
});

test("the server folder listing reaches only the window's own connection", async (t) => {
  const f = twoConnectionFixture(t);
  const listed = await f.invoke(f.server.webContents, DESKTOP_IPC.listServerDirectories, '/srv', true);
  assert.deepEqual(listed, { label: 'server-a', method: 'listServerDirectories', args: ['/srv', true] });
  await f.invoke(f.server.webContents, DESKTOP_IPC.listServerDirectories, '');
  assert.deepEqual(f.server.service.calls, ['listServerDirectories', 'listServerDirectories']);
  assert.deepEqual(f.local.service.calls, []);
});

function fakeConnection(spec, start) {
  const connection = {
    id: spec.id,
    kind: 'ssh',
    started: 0,
    disposed: 0,
    async start() {
      connection.started += 1;
      await start();
    },
    async dispose() {
      connection.disposed += 1;
    },
  };
  return connection;
}

function managerFixture(start = async () => {}, showWindow = null) {
  const pool = new ConnectionPool();
  const created = [];
  const shown = [];
  const closedWindows = [];
  const manager = createConnectionManager({
    pool,
    createConnection: (spec, onProgress) => {
      const connection = fakeConnection(spec, start);
      connection.onProgress = onProgress;
      created.push(connection);
      return connection;
    },
    showWindow: (connection) => {
      shown.push(connection.id);
      return showWindow?.(connection);
    },
    closeWindows: (id) => closedWindows.push(id),
  });
  return { pool, created, shown, closedWindows, manager };
}

test('the manager attaches once, focuses on reopen and detaches on close', async () => {
  const f = managerFixture();
  const spec = { id: 'srv-1', name: 'Build box', target: 'root@127.0.0.1:2223' };
  const progress = () => {};
  await Promise.all([f.manager.open(spec, progress), f.manager.open(spec)]);
  assert.equal(f.created.length, 1, 'concurrent opens share one attachment');
  assert.equal(f.created[0].onProgress, progress);
  assert.equal(f.manager.isOpen('srv-1'), true);
  await f.manager.open(spec);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.shown, ['srv-1', 'srv-1', 'srv-1']);
  await f.manager.close('srv-1');
  assert.equal(f.manager.isOpen('srv-1'), false);
  assert.deepEqual(f.closedWindows, ['srv-1']);
  assert.equal(f.created[0].disposed, 1);
  assert.equal(f.manager.isOpen('local'), false);
  await assert.rejects(f.manager.close('local'), /cannot be disconnected/);
  await assert.rejects(f.manager.open({ id: 'local', name: 'x', target: 'host' }), /this PC/);
});

test('a close cancels an open that has not attached or shown yet, and a reopen works', async () => {
  const f = managerFixture(
    async () => delay(15),
    async () => delay(15)
  );
  const spec = { id: 'srv-9', name: 'Box', target: 'root@127.0.0.1:2223' };

  // Closed before the queued open even started: it never dials.
  const queued = f.manager.open(spec);
  await f.manager.close('srv-9');
  await assert.rejects(queued, /connection-closed/);
  assert.equal(f.created.length, 0);

  // Closed while attaching: the attachment is disposed, no window is shown.
  const attaching = f.manager.open(spec);
  await waitUntil(() => f.created.length > 0, 'the open to start attaching');
  assert.equal(f.created.length, 1);
  await f.manager.close('srv-9');
  await assert.rejects(attaching, /connection-closed/);
  assert.ok(f.created[0].disposed > 0);
  assert.deepEqual(f.shown, []);
  assert.equal(f.manager.isOpen('srv-9'), false);

  // Closed while its window was being built: that window is closed again.
  const showing = f.manager.open(spec);
  await waitUntil(() => f.shown.length > 0, 'the window to be shown');
  await f.manager.close('srv-9');
  await assert.rejects(showing, /connection-closed/);
  assert.equal(f.created[1].disposed, 1);
  assert.deepEqual(f.closedWindows, ['srv-9', 'srv-9'], "close's sweep, then the late window");
  assert.equal(f.manager.isOpen('srv-9'), false);
  assert.equal(f.pool.has('srv-9'), false);

  // A fresh open after the close attaches and shows normally.
  await f.manager.open(spec);
  assert.equal(f.manager.isOpen('srv-9'), true);
  assert.equal(f.created.length, 3);
  assert.equal(f.created[2].disposed, 0);
  assert.deepEqual(f.shown, ['srv-9', 'srv-9']);
});

test('closeAll cancels queued and attaching opens', async () => {
  const f = managerFixture(async () => delay(15));
  const a = { id: 'srv-10', name: 'A', target: 'root@127.0.0.1:2223' };
  const b = { id: 'srv-11', name: 'B', target: 'root@127.0.0.1:2224' };
  const attaching = f.manager.open(a);
  await waitUntil(() => f.created.length > 0, 'the first open to start attaching');
  const queued = f.manager.open(b);
  await f.manager.closeAll();
  const results = await Promise.allSettled([attaching, queued]);
  assert.deepEqual(
    results.map((result) => result.status === 'rejected' && /connection-closed/.test(result.reason.message)),
    [true, true]
  );
  assert.equal(f.created.length, 1, 'the queued open never dialed');
  assert.ok(f.created[0].disposed > 0);
  assert.deepEqual(f.shown, []);
  assert.deepEqual(f.pool.list(), []);
  await f.manager.open(b);
  assert.equal(f.manager.isOpen('srv-11'), true);
  assert.equal(f.manager.isOpen('srv-10'), false);
});

/** Windows as main keeps them: one per connection id, registered only after
 *  the creation's own await (saved bounds, renderer session). */
function windowFixture(initial = []) {
  const windows = new Map(initial.map((id) => [id, { focused: 0 }]));
  const built = [];
  const deps = {
    find: (id) => windows.get(id) ?? null,
    focus: (window) => {
      window.focused += 1;
    },
    create: async (connection) => {
      await delay(15);
      built.push(connection.id);
      windows.set(connection.id, { focused: 0 });
    },
  };
  return { windows, built, deps };
}

test('concurrent opens of one server attach once and build one window', async () => {
  // A check-then-create window step, as main's was: the manager alone must
  // keep a second open from passing the check while the first still builds.
  const naive = windowFixture();
  const naiveShow = async (connection) => {
    const existing = naive.deps.find(connection.id);
    if (existing) return naive.deps.focus(existing);
    await naive.deps.create(connection);
  };
  const f = managerFixture(async () => delay(5), naiveShow);
  const spec = { id: 'srv-5', name: 'Box', target: 'root@127.0.0.1:2223' };
  await Promise.all([f.manager.open(spec), f.manager.open(spec), f.manager.open(spec)]);
  assert.equal(f.created.length, 1, 'one attachment');
  assert.deepEqual(naive.built, ['srv-5'], 'one window');
  assert.equal(naive.windows.get('srv-5').focused, 2, 'later opens focus it');

  // The window opener holds the same line for callers outside the manager.
  const w = windowFixture();
  const show = createConnectionWindowOpener(w.deps);
  await Promise.all([show({ id: 'srv-6' }), show({ id: 'srv-6' }), show({ id: 'srv-6' })]);
  assert.deepEqual(w.built, ['srv-6']);
  assert.equal(w.windows.get('srv-6').focused, 2);
});

test("this PC's window comes back while a server window stays open", async () => {
  // macOS Dock activation with the local window closed and a server window up.
  const w = windowFixture(['srv-7']);
  const show = createConnectionWindowOpener(w.deps);
  await Promise.all([show({ id: 'local' }), show({ id: 'local' })]);
  assert.deepEqual(w.built, ['local'], 'recreated once, though another window exists');
  assert.equal(w.windows.get('srv-7').focused, 0, 'the server window is left alone');
  w.windows.delete('local');
  await show({ id: 'local' });
  assert.deepEqual(w.built, ['local', 'local'], 'closed again: built again');
  // A failed build reaches every waiting caller and leaves no stale guard.
  const failing = createConnectionWindowOpener({
    ...w.deps,
    create: async () => {
      await delay(5);
      throw new Error('renderer failed');
    },
  });
  w.windows.delete('local');
  const results = await Promise.allSettled([failing({ id: 'local' }), failing({ id: 'local' })]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected']
  );
  await assert.rejects(failing({ id: 'local' }), /renderer failed/);
});

test("a server connection's startup deadline outlasts a first install", async () => {
  // Probe, then the longest ensure run (upload + npm install + daemon start),
  // then the tunnel: the client must not give up before the bootstrap would.
  const bootstrapWorstCase =
    REMOTE_PROBE_TIMEOUT_MS +
    Math.max(REMOTE_INSTALL_TIMEOUT_MS, REMOTE_ENSURE_TIMEOUT_MS) +
    REMOTE_TUNNEL_READY_TIMEOUT_MS;
  assert.ok(REMOTE_STARTUP_TIMEOUT_MS > bootstrapWorstCase, `${REMOTE_STARTUP_TIMEOUT_MS} <= ${bootstrapWorstCase}`);
  const deps = {
    moduleUrl: () => 'file:///daemon.cjs',
    environmentReady: () => Promise.resolve(),
    sessionOptions: () => ({
      userDataPath: 'C:\\profile',
      packaged: false,
      resourcesPath: '',
      appPath: '',
      appVersion: '0.0.0',
      rendererDir: '',
    }),
    loadModelProxyRuntime: async () => {
      throw new Error('unused');
    },
    appVersion: '0.0.0',
    bundlePath: 'daemon.cjs',
  };
  const server = createDesktopConnection(
    { id: 'srv-8', kind: 'ssh', name: 'Box', target: 'root@127.0.0.1:2223' },
    deps
  );
  const local = createDesktopConnection({ id: 'local', kind: 'local', name: 'PC' }, deps);
  try {
    assert.equal(server.client.options.startupTimeoutMs, REMOTE_STARTUP_TIMEOUT_MS);
    assert.equal(server.remote.config.tunnelReadyTimeoutMs, REMOTE_TUNNEL_READY_TIMEOUT_MS);
    assert.equal(local.client.options.startupTimeoutMs, undefined, "this PC's daemon keeps the default deadline");
  } finally {
    await Promise.all([server.dispose(), local.dispose()]);
  }
});

test('a terminal ssh failure rejects with its own error and leaves nothing attached', async () => {
  const refusal = new RemoteBootstrapError('node-missing', 'node is not installed on the server');
  const f = managerFixture(async () => {
    throw Object.assign(new Error('transport exited'), { cause: refusal });
  });
  const spec = { id: 'srv-2', name: 'Box', target: 'root@127.0.0.1:2223' };
  await assert.rejects(f.manager.open(spec), (error) => error === refusal);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].started, 1, 'no retry after a terminal failure');
  assert.equal(f.created[0].disposed, 1);
  assert.equal(f.manager.isOpen('srv-2'), false);
  assert.deepEqual(f.shown, []);
  await assert.rejects(f.manager.open({ id: 'srv-3', name: 'Bad', target: 'bad host;rm' }), SshTargetError);
  assert.equal(f.created.length, 1, 'a malformed target never dials');
});

test('a server connection hands onProgress to its RemoteSession and detaches cleanly', async () => {
  const onProgress = () => {};
  const connection = createDesktopConnection(
    { id: 'srv-4', kind: 'ssh', name: 'Box', target: 'root@127.0.0.1:2223' },
    {
      moduleUrl: () => 'file:///daemon.cjs',
      environmentReady: () => Promise.resolve(),
      sessionOptions: () => ({
        userDataPath: 'C:\\profile',
        packaged: false,
        resourcesPath: '',
        appPath: '',
        appVersion: '0.0.0',
        rendererDir: '',
      }),
      loadModelProxyRuntime: async () => {
        throw new Error('unused');
      },
      appVersion: '0.0.0',
      bundlePath: 'daemon.cjs',
    },
    { onProgress }
  );
  assert.equal(connection.kind, 'ssh');
  assert.equal(connection.target, 'root@127.0.0.1:2223');
  assert.equal(connection.remote.config.onProgress, onProgress);
  assert.throws(() => connection.serviceUserDataPath(), /not attached/);
  await connection.dispose();
  await assert.rejects(connection.start(), /disposed/);
});
