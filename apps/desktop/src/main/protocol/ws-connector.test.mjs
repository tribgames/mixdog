import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { createLinkLog } from '../../../../../packages/protocol-client/src/link-log.mjs';
import { createWsConnector } from './ws-connector.ts';

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
