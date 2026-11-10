import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { adoptPrivateProxy, getLlmDispatcher, recycleLlmDispatcher } from './http-agent.mjs';

// Its own file: the system-proxy router is adopted once per process.
test('under the system-proxy router the LLM pool stays the direct leg and recycling still replaces it', async () => {
  const saved = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NODE_USE_ENV_PROXY'].map((key) => [
    key,
    process.env[key],
  ]);
  for (const [key] of saved) delete process.env[key];
  const previous = getGlobalDispatcher();
  let pendingResponse;
  const pending = Promise.withResolvers();
  const server = createServer((req, res) => {
    if (req.url === '/pending') {
      pendingResponse = res;
      pending.resolve();
    } else {
      res.end('fresh');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const asked = [];
  try {
    assert.equal(
      adoptPrivateProxy((origin) => {
        asked.push(origin);
        return { proxy: null };
      }),
      true
    );
    const router = getGlobalDispatcher();
    assert.equal(getLlmDispatcher(), undefined);
    assert.equal(getGlobalDispatcher(), router, 'the pool is never installed over the router');
    const inFlight = fetch(`${base}/pending`).then((response) => response.text());
    await pending.promise;
    assert.equal(recycleLlmDispatcher(), true);
    assert.equal(await (await fetch(`${base}/next`)).text(), 'fresh');
    pendingResponse.end('preserved');
    assert.equal(await inFlight, 'preserved');
    assert.deepEqual(asked, [], 'a local host is never looked up');
  } finally {
    pendingResponse?.end();
    const owned = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    await owned.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});
