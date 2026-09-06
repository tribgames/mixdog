import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { getLlmDispatcher, recycleLlmDispatcher } from './http-agent.mjs';

test('pool replacement permits SDK retries and drains another active request', async () => {
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY'];
  const saved = proxyKeys.map((key) => [key, process.env[key]]);
  for (const key of proxyKeys) delete process.env[key];
  const previous = getGlobalDispatcher();
  let pendingResponse;
  let markPending;
  const pending = new Promise((resolve) => { markPending = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/pending') {
      pendingResponse = res;
      markPending();
    } else {
      res.end('fresh');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    getLlmDispatcher();
    const inFlight = fetch(`${base}/pending`).then((response) => response.text());
    await pending;
    assert.equal(recycleLlmDispatcher(), true);
    // Deliberately do NOT call getLlmDispatcher again: SDK retries use fetch.
    assert.equal(await (await fetch(`${base}/next`)).text(), 'fresh');
    pendingResponse.end('preserved');
    assert.equal(await inFlight, 'preserved');

    // A second generation must also remain usable after repeated failures.
    assert.equal(recycleLlmDispatcher(), true);
    assert.equal(await (await fetch(`${base}/again`)).text(), 'fresh');
  } finally {
    pendingResponse?.end();
    const owned = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    await owned.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('pool replacement preserves a custom global dispatcher', async () => {
  const previous = getGlobalDispatcher();
  let dispatched = 0;
  class CustomAgent extends Agent {
    dispatch(options, handler) {
      dispatched += 1;
      return super.dispatch(options, handler);
    }
  }
  const custom = new CustomAgent();
  const server = createServer((_req, res) => res.end('custom'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  setGlobalDispatcher(custom);
  try {
    assert.equal(getLlmDispatcher(), undefined);
    assert.equal(recycleLlmDispatcher(), false);
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text(), 'custom');
    assert.equal(dispatched, 1);
  } finally {
    setGlobalDispatcher(previous);
    await custom.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
