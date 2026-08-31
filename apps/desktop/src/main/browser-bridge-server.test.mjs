import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BrowserBridgeServer } from './browser-bridge-server.ts';

test('browser bridge authenticates commands and removes its discovery file', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-browser-bridge-'));
  const discoveryPath = join(dataDirectory, 'browser-bridge.json');
  let ready;
  let releaseHeld;
  let announceHeld;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const held = new Promise((resolve) => {
    announceHeld = resolve;
  });
  const heldRelease = new Promise((resolve) => {
    releaseHeld = resolve;
  });
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
