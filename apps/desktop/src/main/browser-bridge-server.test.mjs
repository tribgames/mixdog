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
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const server = new BrowserBridgeServer({
    dataDirectory,
    redactError: String,
    execute: async (command) => ({ echoed: command.action }),
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

    await server.stop();
    assert.equal(existsSync(discoveryPath), false);
  } finally {
    await server.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
