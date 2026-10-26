import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { waitUntil } from '../bounded-wait.mjs';
import { TerminalBridgeServer } from './bridge-server.ts';
import { createTerminalCommandExecutor } from './commands.ts';

function fakeBackend() {
  const tabs = {
    alpha: [
      { tab: 1, id: 'session-terminal:alpha', shell: 'pwsh', running: true, cwd: 'C:\\work' },
      { tab: 3, id: 'session-terminal:alpha:3', shell: 'bash', running: false, cwd: null },
    ],
    beta: [{ tab: 1, id: 'session-terminal:beta', shell: 'sh', running: true, cwd: null }],
  };
  const seen = [];
  return {
    seen,
    sessionTabs: (sessionId) => tabs[sessionId] ?? [],
    snapshot: (id, since) => {
      seen.push([id, since]);
      return { text: `output of ${id}`, cursor: 42, reset: false };
    },
  };
}

test('terminal commands list only the caller session and read by tab', async () => {
  const backend = fakeBackend();
  const execute = createTerminalCommandExecutor(backend);
  assert.deepEqual(await execute({ action: 'list', session_id: 'alpha' }), {
    tabs: [
      { tab: 1, shell: 'pwsh', running: true, cwd: 'C:\\work' },
      { tab: 3, shell: 'bash', running: false, cwd: null },
    ],
  });
  assert.deepEqual((await execute({ action: 'list', session_id: 'gamma' })).tabs, []);

  const first = await execute({ action: 'read', session_id: 'alpha' });
  assert.equal(first.id, 'session-terminal:alpha');
  assert.equal(first.raw, 'output of session-terminal:alpha');
  const third = await execute({ action: 'read', session_id: 'alpha', tab: 3, since: 7 });
  assert.equal(third.tab, 3);
  assert.deepEqual(backend.seen.at(-1), ['session-terminal:alpha:3', 7]);

  // Another session's tab is never reachable, whatever the tab number.
  await assert.rejects(execute({ action: 'read', session_id: 'beta', tab: 3 }), /no terminal tab 3; open tabs: 1/);
  await assert.rejects(execute({ action: 'read', session_id: 'gamma' }), /no terminal tabs/);
  await assert.rejects(execute({ action: 'write', session_id: 'alpha' }), /unsupported terminal action/);
  await assert.rejects(execute({ action: 'list', session_id: '../x' }), /session_id is invalid/);
  await assert.rejects(execute({ action: 'read', session_id: 'alpha', tab: 0 }), /tab must be/);
});

function runBackend({ shown = true } = {}) {
  const base = fakeBackend();
  const log = [];
  const tabs = { alpha: base.sessionTabs('alpha'), beta: [] };
  return {
    log,
    tabs,
    sessionTabs: (sessionId) => tabs[sessionId] ?? [],
    snapshot: (id, since) => {
      log.push(['snapshot', id, since]);
      return { text: '', cursor: 99, reset: false };
    },
    write: (id, data) => log.push(['write', id, data]),
    revealTerminal: async (sessionId, target) => (log.push(['reveal', sessionId, target.id]), shown),
    startTerminal: (sessionId) => {
      log.push(['start', sessionId]);
      tabs[sessionId] = [{ tab: 1, id: `session-terminal:${sessionId}`, shell: 'sh', running: true, cwd: null }];
      return tabs[sessionId][0];
    },
  };
}

test('terminal run writes to the first or requested tab with the pre-write cursor', async () => {
  const backend = runBackend();
  const execute = createTerminalCommandExecutor(backend);
  assert.deepEqual(await execute({ action: 'run', session_id: 'alpha', command: 'npm test\n' }), {
    id: 'session-terminal:alpha',
    tab: 1,
    shell: 'pwsh',
    running: true,
    cwd: 'C:\\work',
    cursor: 99,
    shown: true,
  });
  assert.deepEqual(backend.log, [
    ['snapshot', 'session-terminal:alpha', undefined],
    ['write', 'session-terminal:alpha', 'npm test\r'],
    ['reveal', 'alpha', 'session-terminal:alpha'],
  ]);
  backend.log.length = 0;
  const third = await execute({ action: 'run', session_id: 'alpha', tab: 3, command: 'ls' });
  assert.equal(third.tab, 3);
  assert.deepEqual(backend.log[1], ['write', 'session-terminal:alpha:3', 'ls\r']);
  await assert.rejects(
    execute({ action: 'run', session_id: 'alpha', tab: 2, command: 'ls' }),
    /no terminal tab 2; open tabs: 1, 3/
  );
});

test('terminal run starts the first terminal itself when the session has none, shown or not', async () => {
  const backend = runBackend({ shown: false });
  const execute = createTerminalCommandExecutor(backend);
  assert.deepEqual(await execute({ action: 'run', session_id: 'beta', command: 'pwd' }), {
    id: 'session-terminal:beta',
    tab: 1,
    shell: 'sh',
    running: true,
    cwd: null,
    cursor: 99,
    shown: false,
  });
  assert.deepEqual(backend.log, [
    ['start', 'beta'],
    ['snapshot', 'session-terminal:beta', undefined],
    ['write', 'session-terminal:beta', 'pwd\r'],
    ['reveal', 'beta', 'session-terminal:beta'],
  ]);
  await assert.rejects(execute({ action: 'run', session_id: 'gamma', tab: 2, command: 'pwd' }), /no terminal tab 2/);
});

test('a run cancelled while its terminal starts, or before the write, never writes', async () => {
  const during = new AbortController();
  const startBackend = runBackend();
  const startTerminal = startBackend.startTerminal;
  startBackend.startTerminal = async (sessionId) => {
    const started = startTerminal(sessionId);
    during.abort();
    return started;
  };
  await assert.rejects(
    createTerminalCommandExecutor(startBackend)({ action: 'run', session_id: 'beta', command: 'pwd' }, during.signal),
    /cancelled/
  );
  assert.deepEqual(
    startBackend.log.filter(([kind]) => kind === 'write' || kind === 'reveal'),
    []
  );

  const late = new AbortController();
  const snapBackend = runBackend();
  const snapshot = snapBackend.snapshot;
  snapBackend.snapshot = async (id, since) => {
    const result = await snapshot(id, since);
    late.abort();
    return result;
  };
  await assert.rejects(
    createTerminalCommandExecutor(snapBackend)({ action: 'run', session_id: 'alpha', command: 'ls' }, late.signal),
    /cancelled/
  );
  assert.deepEqual(
    snapBackend.log.filter(([kind]) => kind === 'write' || kind === 'reveal'),
    []
  );

  const before = new AbortController();
  before.abort();
  const idle = runBackend();
  await assert.rejects(
    createTerminalCommandExecutor(idle)({ action: 'run', session_id: 'beta', command: 'pwd' }, before.signal),
    /cancelled/
  );
  assert.deepEqual(idle.log, []);
});

test('terminal run validates its input before touching a terminal', async () => {
  const backend = runBackend();
  const execute = createTerminalCommandExecutor(backend);
  await assert.rejects(execute({ action: 'run', session_id: 'alpha' }), /command must be a non-empty string/);
  await assert.rejects(execute({ action: 'run', session_id: 'alpha', command: '  \n' }), /non-empty/);
  await assert.rejects(execute({ action: 'run', session_id: 'alpha', command: 7 }), /non-empty/);
  await assert.rejects(execute({ action: 'run', session_id: 'alpha', command: 'x'.repeat(8001) }), /at most 8000/);
  await assert.rejects(execute({ action: 'run', session_id: 'alpha', tab: 0, command: 'ls' }), /tab must be/);
  await assert.rejects(execute({ action: 'run', session_id: '../x', command: 'ls' }), /session_id is invalid/);
  assert.deepEqual(backend.log, []);
  assert.equal((await execute({ action: 'run', session_id: 'alpha', command: 'x'.repeat(8000) })).tab, 1);
});

test('an explicit stop during a lost-endpoint restart is not undone', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-terminal-bridge-'));
  const discoveryPath = join(dataDirectory, 'terminal-bridge.json');
  const { promise: readyPromise, resolve: ready } = Promise.withResolvers();
  const server = new TerminalBridgeServer({
    dataDirectory,
    execute: createTerminalCommandExecutor(fakeBackend()),
    onReady: ready,
    heartbeatMs: 20,
  });
  try {
    server.start();
    await readyPromise;
    const original = server.stop.bind(server);
    let stopping;
    server.stop = (internal) => {
      if (internal === true && !stopping) {
        // The restart's own stop is in flight: issue the explicit stop now.
        const inner = original(true);
        stopping = original();
        return inner.then(() => stopping);
      }
      return original(internal);
    };
    // Kill only the listener: the discovery file stays ours but points nowhere.
    server.server.close();
    server.server.closeAllConnections();
    await waitUntil(() => stopping, 'the lost-endpoint restart to stop the server', { pollMs: 5 });
    assert.ok(stopping, 'the lost-endpoint restart must have run');
    await stopping;
    assert.equal(server.server, null);
    assert.equal(existsSync(discoveryPath), false);
  } finally {
    await server.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('terminal bridge authenticates commands and removes its discovery file', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-terminal-bridge-'));
  const discoveryPath = join(dataDirectory, 'terminal-bridge.json');
  const { promise: readyPromise, resolve: ready } = Promise.withResolvers();
  const server = new TerminalBridgeServer({
    dataDirectory,
    execute: createTerminalCommandExecutor(fakeBackend()),
    onReady: ready,
  });
  try {
    server.start();
    await readyPromise;
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    const url = `http://127.0.0.1:${discovery.port}/command`;
    const post = (body, token = discovery.token) =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    assert.equal((await post({ action: 'list', session_id: 'alpha' }, 'wrong')).status, 401);
    const listed = await (await post({ action: 'list', session_id: 'alpha' })).json();
    assert.equal(listed.ok, true);
    assert.equal(listed.value.tabs.length, 2);
    const failed = await (await post({ action: 'read', session_id: 'gamma' })).json();
    assert.deepEqual(failed, { ok: false, error: 'no terminal tabs are open for this session' });
    assert.equal((await fetch(url, { method: 'GET' })).status, 404);
  } finally {
    await server.stop();
  }
  assert.equal(existsSync(discoveryPath), false);
  rmSync(dataDirectory, { recursive: true, force: true });
});
