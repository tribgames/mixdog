import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
    await new Promise((resolve) => setTimeout(resolve, 300));
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
