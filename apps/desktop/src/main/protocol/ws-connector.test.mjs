import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { createLinkLog } from '../../../../../packages/protocol-client/src/link-log.mjs';
import { createWsConnector } from './ws-connector.ts';
import { observeSocketProgress, resetSocketProgressNotice } from './socket-progress.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function listener(onConnection) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((done) => server.once('listening', done));
  server.on('connection', onConnection);
  return { url: `ws://127.0.0.1:${server.address().port}/rpc`, close: () => server.close() };
}

test('a socket the core closes is recorded once, with its code, reason, age and who ended it', async (t) => {
  t.mock.method(console, 'error', () => {});
  const core = await listener((socket) => socket.close(4001, 'pingDeadline'));
  const lines = [];
  const log = createLinkLog((event, fields) => lines.push({ event, ...fields }), { link: 'main', owner: 'local' });
  const connector = createWsConnector(async () => ({ url: core.url, token: 'secret-token' }), log);
  const closed = new Promise((resolve) => {
    connector.open({ id: 'core' }, { frame() {}, closed: (code, reason) => resolve({ code, reason }) });
  });
  assert.deepEqual(await closed, { code: 4001, reason: 'pingDeadline' });
  await flush();
  assert.deepEqual(lines.map((l) => l.event), ['core-socket-open', 'core-socket-close']);
  assert.equal(lines[1].code, 4001);
  assert.equal(lines[1].reason, 'pingDeadline');
  assert.equal(lines[1].initiator, 'core-or-network');
  assert.equal(lines[1].owner, 'local');
  assert.equal(typeof lines[1].openMs, 'number');
  assert.equal(JSON.stringify(lines).includes('secret-token'), false, 'no token in a link line');
  core.close();
});

test('a close the desktop asks for is recorded as the desktop\'s, even when the log itself fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const sockets = [];
  const core = await listener((socket) => sockets.push(socket));
  const lines = [];
  let failing = true;
  const log = createLinkLog((event, fields) => {
    lines.push({ event, ...fields });
    if (failing) throw new Error('the sink failed');
  });
  const connector = createWsConnector(async () => ({ url: core.url, token: 't' }), log);
  const writer = await connector.open({ id: 'core' }, { frame() {}, closed() {} });
  const serverSawClose = new Promise((resolve) => sockets[0].once('close', (code) => resolve(code)));
  writer.close(1000, 'done');
  assert.equal(await serverSawClose, 1000, 'the socket closed although every log write threw');
  await flush();
  failing = false;
  assert.equal(lines.find((l) => l.event === 'core-socket-close').initiator, 'desktop');
  core.close();
});

test('a dial that cannot open is recorded as failed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const core = await listener(() => {});
  const url = core.url;
  core.close();
  const lines = [];
  const log = createLinkLog((event, fields) => lines.push({ event, ...fields }));
  const connector = createWsConnector(async () => ({ url, token: 't' }), log);
  await assert.rejects(connector.open({ id: 'core' }, { frame() {}, closed() {} }));
  await flush();
  assert.deepEqual(lines.map((l) => l.event), ['core-socket-open-failed']);
});

test('progress: a large response is reported while it is still arriving, through the real socket, before the message is whole', async (t) => {
  t.mock.method(console, 'error', () => {});
  const big = Buffer.alloc(8_000_000, 97);
  const core = await listener((socket) => {
    // The first part of the message, then a pause: the rest arrives later.
    socket.once('message', () => {
      const raw = socket._socket;
      raw.cork();
      socket.send(big.toString('utf8'));
      raw.uncork();
    });
  });
  const events = [];
  const connector = createWsConnector(async () => ({ url: core.url, token: 't' }), undefined);
  const writer = await connector.open({ id: 'core' }, {
    frame: () => events.push('frame'),
    progress: () => events.push('progress'),
    closed() {},
  });
  writer.send('go');
  await new Promise((resolve) => {
    const timer = setInterval(() => events.includes('frame') && (clearInterval(timer), resolve()), 10);
  });
  assert.ok(events.includes('progress'), 'bytes were reported');
  assert.ok(events.indexOf('progress') < events.indexOf('frame'), 'the first report came before the message was whole');
  writer.close(1000, 'done');
  core.close();
});

test('progress: a socket without the raw stream is said once in the log, and reports nothing', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  resetSocketProgressNotice();
  let reports = 0;
  observeSocketProgress({}, () => reports++);
  observeSocketProgress({}, () => reports++);
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(reports, 0);
});

test('receipt: the claim of a frame is the ws send callback — it resolves when the write completed, and rejects when the socket is gone', async (t) => {
  t.mock.method(console, 'error', () => {});
  const sockets = [];
  const core = await listener((socket) => sockets.push(socket));
  const connector = createWsConnector(async () => ({ url: core.url, token: 't' }), undefined);
  const writer = await connector.open({ id: 'core' }, { frame() {}, closed() {} });
  let receipt;
  writer.send('{"id":1}', (promise) => (receipt = promise));
  await receipt;
  writer.close(1000, 'done');
  await new Promise((resolve) => setTimeout(resolve, 50));
  let late;
  writer.send('{"id":2}', (promise) => (late = promise));
  await assert.rejects(late, 'a write on a closed socket is not a receipt');
  core.close();
});

test('socket-progress: the real ws library still exposes the raw socket this relies on, and its reads are what is reported', async () => {
  const { default: WebSocket } = await import('ws');
  let serverSide;
  const core = await listener((socket) => (serverSide = socket));
  const client = new WebSocket(core.url);
  await new Promise((resolve, reject) => (client.once('open', resolve), client.once('error', reject)));
  assert.equal(typeof client._socket?.on, 'function', 'ws keeps the net socket it upgraded as _socket');
  let reports = 0;
  observeSocketProgress(client, () => reports++, () => 0, 0);
  serverSide.send('x'.repeat(100_000));
  await new Promise((resolve) => client.once('message', resolve));
  assert.ok(reports >= 1, 'the bytes of the message were reported by the raw socket');
  client.close();
  core.close();
});
