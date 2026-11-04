// Cancelling a connection that is still waiting for the proxy's CONNECT answer
// releases its sockets: nothing is left tunnelled to the destination.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { openCursorStream } from '../../agent/orchestrator/providers/cursor-wire-transport.mjs';
import { createWsConnection } from '../../agent/orchestrator/providers/openai-ws-connect.mjs';
import { eventually, settle } from '../watched-file-cache.test-helpers.mjs';
import { _resetProxySettingForTest, currentProxySetting } from './proxy-policy.mjs';
import { connectHttp2Session, openProxyTunnel, openTunnelFor } from './proxy-tunnel.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-cancel-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => {
  _resetProxySettingForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A proxy that answers CONNECT only after `delayMs`, counting what it saw and what was closed on it. */
async function slowProxy(delayMs) {
  const seen = { connects: 0, answered: 0, closed: 0 };
  const server = http.createServer();
  server.on('connect', (_req, socket) => {
    seen.connects += 1;
    socket.on('error', () => {});
    socket.on('close', () => (seen.closed += 1));
    // A proxy ends its side when the client has hung up (the server socket is half-open by default).
    socket.on('end', () => socket.end());
    socket.resume();
    setTimeout(() => {
      if (socket.destroyed) return;
      seen.answered += 1;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    }, delayMs).unref();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { networkProxy: { mode: 'manual', url } } }));
  await eventually(() => currentProxySetting().url === url);
  return { seen, address: `127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) };
}

test('closing a Cursor stream while the proxy has not answered ends the CONNECT at once', async () => {
  const proxy = await slowProxy(1_500);
  try {
    const stream = openCursorStream({ accessToken: 't', path: '/p', url: 'https://203.0.113.9' });
    const ended = new Promise((resolve) => stream.onClose(resolve));
    await eventually(() => proxy.seen.connects === 1);
    stream.close();
    await ended;
    await eventually(() => proxy.seen.closed === 1, { timeoutMs: 1_000 });
    assert.equal(proxy.seen.answered, 0, 'released before the proxy answered');
  } finally {
    proxy.close();
  }
});

test('a WebSocket handshake that gives up before the tunnel is up destroys the tunnel when it arrives', async () => {
  const proxy = await slowProxy(400);
  try {
    const socket = new WebSocket('ws://203.0.113.9:9/x', { createConnection: createWsConnection, handshakeTimeout: 100 });
    const failed = await new Promise((resolve) => socket.once('error', resolve));
    assert.ok(failed, 'the handshake failed');
    await eventually(() => proxy.seen.answered === 1, { timeoutMs: 2_000 });
    await eventually(() => proxy.seen.closed === 1, { timeoutMs: 2_000 });
  } finally {
    proxy.close();
  }
});

test('a cancel before the CONNECT starts sends none, at the route lookup, the tunnel and the HTTP/2 build', async () => {
  const proxy = await slowProxy(50);
  try {
    const reason = new Error('cancelled');
    const aborted = AbortSignal.abort(reason);
    await assert.rejects(openProxyTunnel(`http://${proxy.address}`, '203.0.113.9', 443, { signal: aborted }), reason);
    await assert.rejects(openTunnelFor('https://203.0.113.9', { signal: aborted }), reason);
    await assert.rejects(connectHttp2Session('https://203.0.113.9', undefined, { signal: aborted }), reason);

    // Aborted while the route is being looked up: the abort lands after the call began.
    const late = new AbortController();
    const pending = openTunnelFor('https://203.0.113.9', { signal: late.signal });
    late.abort(reason);
    await assert.rejects(pending, reason);

    // A Cursor stream closed in the same tick it was opened.
    const stream = openCursorStream({ accessToken: 't', path: '/p', url: 'https://203.0.113.9' });
    const ended = new Promise((resolve) => stream.onClose(resolve));
    stream.close();
    await ended;

    await settle(300);
    assert.equal(proxy.seen.connects, 0, 'no CONNECT was ever sent');
  } finally {
    proxy.close();
  }
});

test('a Cursor unary call that times out first does not leave its tunnel behind', async () => {
  const proxy = await slowProxy(1_500);
  const { callCursorUnary } = await import('../../agent/orchestrator/providers/cursor-wire-transport.mjs');
  try {
    process.env.MIXDOG_CURSOR_CLIENT_VERSION = 'cli-test';
    await assert.rejects(
      callCursorUnary({ accessToken: 't', path: '/p', body: Buffer.alloc(1), url: 'https://203.0.113.9', timeoutMs: 100 })
    );
    await eventually(() => proxy.seen.closed === 1, { timeoutMs: 1_000 });
    assert.equal(proxy.seen.answered, 0);
    await settle(50);
  } finally {
    proxy.close();
  }
});
