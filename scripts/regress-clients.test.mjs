import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { open } from './regress-clients.mjs';

const serve = () =>
  new Promise((resolve) => {
    const received = [];
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
      const doc = { core: { rpc: { port: server.address().port } }, endpoints: { session: { token: 't' } } };
      resolve({ server, received, doc });
    });
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString('utf8'));
        received.push(message);
        if (message.method === 'initialize') {
          socket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
        } else if (message.method === 'bye') {
          socket.close(4000, 'bye');
        } else if (message.id !== undefined) {
          socket.send(JSON.stringify({ id: message.id, result: { echo: message.method } }));
        }
      });
    });
  });

test('open sends initialize with the client kind, then initialized, and matches answers to requests', async () => {
  const { server, received, doc } = await serve();
  try {
    const connection = await open(doc, 'phone', '9.9.9');
    assert.deepEqual(await connection.request('thread/list', {}), { id: 2, result: { echo: 'thread/list' } });
    connection.close();
    assert.deepEqual(received[0].params.clientInfo, { name: 'regress-phone', version: '9.9.9', kind: 'phone' });
    assert.equal(received[1].method, 'initialized');
  } finally {
    server.close();
  }
});

test('open without a handshake sends nothing, and a closed connection answers requests with the close reason', async () => {
  const { server, received, doc } = await serve();
  try {
    const connection = await open(doc, 'tui', '1.0.0', { handshake: false });
    assert.equal(received.length, 0);
    const answer = await connection.request('bye', {});
    assert.equal(answer.closed, '4000 bye');
    assert.equal(connection.isClosed(), '4000 bye');
    assert.deepEqual(await connection.request('later', {}), { closed: '4000 bye' });
  } finally {
    server.close();
  }
});
