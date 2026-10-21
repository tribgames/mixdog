import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BrowserBridgeServer } from './bridge-server.ts';

test('browser bridge authenticates commands and removes its discovery file', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-browser-bridge-'));
  const discoveryPath = join(dataDirectory, 'browser-bridge.json');
  const { promise: readyPromise, resolve: ready } = Promise.withResolvers();
  const { promise: held, resolve: announceHeld } = Promise.withResolvers();
  const { promise: heldRelease, resolve: releaseHeld } = Promise.withResolvers();
  const server = new BrowserBridgeServer({
    dataDirectory,
    redactError: String,
    maxConcurrentRequests: 1,
    execute: async (command) => {
      if (command.action === 'hold') {
        announceHeld();
        await heldRelease;
      }
      return { echoed: command.action };
    },
    onReady: ready,
  });

  try {
    server.start();
    await readyPromise;
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    const url = `http://127.0.0.1:${discovery.port}/command`;

    const unauthorized = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${discovery.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'status' }),
    });
    assert.deepEqual(await authorized.json(), {
      ok: true,
      value: { echoed: 'status' },
    });

    const heldRequest = fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${discovery.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'hold' }),
    });
    await held;
    const overloaded = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${discovery.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'status' }),
    });
    assert.equal(overloaded.status, 429);
    assert.match((await overloaded.json()).error, /too many concurrent browser commands/);
    releaseHeld();
    assert.equal((await heldRequest).status, 200);

    await server.stop();
    assert.equal(existsSync(discoveryPath), false);
  } finally {
    await server.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('a command that outlasts the keep-alive period keeps its response alive, then answers in the same JSON shape', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-browser-bridge-'));
  const { promise: readyPromise, resolve: ready } = Promise.withResolvers();
  const gates = new Map();
  const server = new BrowserBridgeServer({
    dataDirectory,
    redactError: String,
    keepAliveMs: 30,
    execute: async (command) => {
      if (command.action === 'quick') return { echoed: 'quick' };
      const gate = Promise.withResolvers();
      gates.set(command.action, gate);
      await gate.promise;
      if (command.action === 'fails') throw new Error('Browser Use approval denied by the user');
      return { echoed: command.action };
    },
    onReady: ready,
  });
  try {
    server.start();
    await readyPromise;
    const discovery = JSON.parse(readFileSync(join(dataDirectory, 'browser-bridge.json'), 'utf8'));
    const post = (action) =>
      fetch(`http://127.0.0.1:${discovery.port}/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });

    // Quick commands answer exactly as before: one sized response, no keep-alive bytes.
    const quick = await post('quick');
    assert.ok(quick.headers.get('content-length'), 'a sized response');
    assert.deepEqual(await quick.json(), { ok: true, value: { echoed: 'quick' } });

    for (const action of ['slow', 'fails']) {
      const response = await post(action);
      assert.equal(response.status, 200, 'the status is committed once the keep-alive starts');
      // Read until at least two keep-alive chunks arrived while the command is still held.
      const reader = response.body.getReader();
      let text = '';
      let chunks = 0;
      while (chunks < 2) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'the response stays open while the command waits');
        text += Buffer.from(value).toString('utf8');
        chunks += 1;
      }
      assert.equal(text.trim(), '', 'only whitespace so far');
      gates.get(action).resolve();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
      const body = JSON.parse(text);
      if (action === 'slow') assert.deepEqual(body, { ok: true, value: { echoed: 'slow' } });
      else {
        assert.equal(body.ok, false);
        assert.equal(body.error, 'Browser Use approval denied by the user');
      }
    }
  } finally {
    await server.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('a client that goes away during the keep-alive aborts the command it was waiting on', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-browser-bridge-'));
  const { promise: readyPromise, resolve: ready } = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const server = new BrowserBridgeServer({
    dataDirectory,
    redactError: String,
    keepAliveMs: 20,
    execute: async (_command, signal) => {
      entered.resolve();
      signal.addEventListener('abort', () => aborted.resolve(signal.reason?.message), { once: true });
      await new Promise(() => {});
    },
    onReady: ready,
  });
  try {
    server.start();
    await readyPromise;
    const discovery = JSON.parse(readFileSync(join(dataDirectory, 'browser-bridge.json'), 'utf8'));
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'hold' }),
      signal: controller.signal,
    });
    await entered.promise;
    const reader = response.body.getReader();
    await reader.read(); // a keep-alive chunk
    controller.abort();
    await reader.read().catch(() => undefined);
    assert.match(await aborted.promise, /client disconnected/);
  } finally {
    await server.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('browser bridge reclaims its discovery file from a dead foreign writer', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-browser-bridge-'));
  const discoveryPath = join(dataDirectory, 'browser-bridge.json');
  const { promise: readyPromise, resolve: ready } = Promise.withResolvers();
  const server = new BrowserBridgeServer({
    dataDirectory,
    redactError: String,
    heartbeatMs: 50,
    execute: async () => ({}),
    onReady: ready,
  });
  try {
    server.start();
    await readyPromise;
    const own = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    assert.equal(own.pid, process.pid);

    // A crashed instance left its record behind: nothing listens on its port.
    const deadListener = createServer();
    await new Promise((resolve) => deadListener.listen(0, '127.0.0.1', resolve));
    const deadPort = deadListener.address().port;
    await new Promise((resolve) => deadListener.close(resolve));
    const foreign = { ...own, port: deadPort, token: 'foreign-dead-token', pid: 1, generation: 9 };
    writeFileSync(discoveryPath, `${JSON.stringify(foreign)}\n`);

    const deadline = Date.now() + 5_000;
    let current = foreign;
    while (Date.now() < deadline && current.token !== own.token) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    }
    assert.deepEqual(current, own);

    const health = await fetch(`http://127.0.0.1:${own.port}/health`, {
      headers: { authorization: `Bearer ${own.token}` },
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).identity.port, own.port);
  } finally {
    await server.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
