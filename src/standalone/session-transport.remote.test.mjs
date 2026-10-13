import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { createSessionTransport } from './session-transport.mjs';
import { SESSION_PROTOCOL } from './session-wire.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function client(discovery) {
  return (path, body, token = discovery.token) =>
    fetch(`http://127.0.0.1:${discovery.port}${path}`, {
      method: 'POST',
      headers: { 'x-mixdog-daemon-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

test('POST /client/heartbeat is token-gated and refreshes only known clients', async () => {
  const transport = createSessionTransport({ handleCall: async () => null, onClientsEmpty: () => {} });
  const discovery = await transport.start();
  const post = client(discovery);
  try {
    const registered = await post('/client/register', { protocol: SESSION_PROTOCOL, remote: true, leaseMs: 5_000 });
    const { token } = await registered.json();
    assert.equal((await post('/client/heartbeat', { token }, 'wrong')).status, 403, 'server token required');
    assert.equal((await post('/client/heartbeat', { token: 'nope' })).status, 404);
    assert.equal((await post('/client/heartbeat', {})).status, 404);
    const ok = await post('/client/heartbeat', { token });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
  } finally {
    await transport.stop();
  }
});

test('GET /health advertises modelProxy: "client" only while MIXDOG_MODEL_PROXY=client', async () => {
  const transport = createSessionTransport({ handleCall: async () => null, onClientsEmpty: () => {} });
  const discovery = await transport.start();
  const health = async () => (await fetch(`http://127.0.0.1:${discovery.port}/health`)).json();
  try {
    assert.equal((await health()).modelProxy, null);
    await withEnv('MIXDOG_MODEL_PROXY', 'client', async () => {
      assert.equal((await health()).modelProxy, 'client');
    });
    assert.equal((await health()).modelProxy, null);
  } finally {
    await transport.stop();
  }
});

test('MIXDOG_SESSION_PORT pins the listen port on loopback', async () => {
  const port = await freePort();
  await withEnv('MIXDOG_SESSION_PORT', String(port), async () => {
    const transport = createSessionTransport({ handleCall: async () => null });
    try {
      assert.equal((await transport.start()).port, port);
    } finally {
      await transport.stop();
    }
  });
});

test('an invalid MIXDOG_SESSION_PORT is ignored, and a busy pinned port fails instead of moving', async () => {
  await withEnv('MIXDOG_SESSION_PORT', '99999', async () => {
    const transport = createSessionTransport({ handleCall: async () => null });
    try {
      const { port } = await transport.start();
      assert.ok(port > 0 && port !== 99999);
    } finally {
      await transport.stop();
    }
  });

  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  try {
    await withEnv('MIXDOG_SESSION_PORT', String(busy), async () => {
      const transport = createSessionTransport({ handleCall: async () => null });
      try {
        await assert.rejects(transport.start(), /MIXDOG_SESSION_PORT/);
      } finally {
        await transport.stop();
      }
    });
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
