import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CLOSE_ALL_CODE, CORE_PORT_CHANNEL, CorePortRelay } from './relay.ts';
import { windowIdFor } from './window-ids.ts';

class FakeSocket extends EventEmitter {
  sent = [];
  closed = null;
  terminated = false;
  send(text) {
    this.sent.push(text);
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = { code, reason };
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason ?? '')));
  }
  terminate() {
    this.terminated = true;
  }
}

class FakePort extends EventEmitter {
  posted = [];
  isClosed = false;
  postMessage(message) {
    this.posted.push(message);
  }
  start() {}
  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close');
  }
}

function webContents(id = 1) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { id, delivered: [], postMessage(channel, message, transfer) { this.delivered.push({ channel, message, transfer }); } });
}

function harness({ scope = 1, endpoints } = {}) {
  const sockets = [];
  const headers = [];
  const ports = [];
  const logs = [];
  const all = endpoints ?? [{ slot: 'primary', url: 'ws://127.0.0.1:1/rpc', token: 'tok', target: 'local', role: 'main' }];
  const relay = new CorePortRelay({
    endpointFor: async () => all,
    coreWindowScope: async () => scope,
    createSocket: (url, h) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      headers.push({ url, ...h });
      if (!harness.refuse) queueMicrotask(() => socket.emit('open'));
      else queueMicrotask(() => socket.emit('unexpected-response', {}, { statusCode: 403 }));
      return socket;
    },
    createChannel: () => {
      const port1 = new FakePort();
      ports.push(port1);
      return { port1, port2: { port2: ports.length } };
    },
    log: (line) => logs.push(line),
  });
  return { relay, sockets, headers, ports, logs };
}
harness.refuse = false;

test('open_pipes_both_ways', async () => {
  const { relay, sockets, ports, headers } = harness();
  const wc = webContents();
  const { generation } = await relay.open(wc);
  assert.equal(wc.delivered[0].channel, CORE_PORT_CHANNEL);
  assert.deepEqual(wc.delivered[0].message, { generation, slot: 'primary', role: 'main', target: 'local' });
  assert.equal(wc.delivered[0].transfer.length, 1);
  assert.equal(headers[0].Authorization, 'Bearer tok');
  assert.equal(headers[0]['Mixdog-Window'], windowIdFor(wc));
  assert.match(windowIdFor(wc), /^[0-9a-f-]{36}$/);
  assert.notEqual(windowIdFor(webContents(1)), windowIdFor(wc));
  sockets[0].emit('message', Buffer.from('from-core'), false);
  assert.deepEqual(ports[0].posted, ['from-core']);
  ports[0].emit('message', { data: 'from-window' });
  assert.deepEqual(sockets[0].sent, ['from-window']);
  sockets[0].emit('message', Buffer.from([1]), true);
  assert.equal(ports[0].posted.length, 1);
});

test('reopen_closes_previous_generation', async () => {
  const { relay, sockets, ports } = harness();
  const wc = webContents();
  const first = await relay.open(wc);
  const second = await relay.open(wc);
  assert.ok(second.generation > first.generation);
  assert.equal(wc.delivered[1].message.generation, second.generation);
  assert.equal(sockets[0].closed.reason, 'superseded');
  assert.equal(ports[0].isClosed, true);
  assert.equal(sockets[1].closed, null);
  assert.equal(ports[0].posted.length, 0);
});

test('socket_close_posts_closed', async () => {
  const { relay, sockets, ports, logs } = harness();
  await relay.open(webContents());
  sockets[0].emit('close', 1006, Buffer.from('gone'));
  assert.deepEqual(ports[0].posted, [{ t: 'closed', code: 1006, reason: 'gone' }]);
  assert.equal(ports[0].isClosed, true);
  assert.ok(logs.some((line) => line.includes('core socket closed') && line.includes('code=1006')));
});

test('an open superseded before its port is delivered rejects and delivers nothing', async () => {
  const { relay, sockets, ports } = harness();
  const wc = webContents();
  const stale = relay.open(wc);
  const fresh = relay.open(wc);
  await assert.rejects(stale, /superseded/);
  const { generation } = await fresh;
  assert.deepEqual(wc.delivered.map((d) => d.message.generation), [generation]);
  assert.equal(sockets.length, 1);
  assert.equal(ports.length, 1);
});

test('port_close_closes_socket', async () => {
  const { relay, sockets, ports } = harness();
  await relay.open(webContents());
  ports[0].emit('message', { data: { t: 'close' } });
  assert.equal(sockets[0].closed.code, 1000);
  const second = harness();
  await second.relay.open(webContents());
  second.ports[0].close();
  assert.ok(second.sockets[0].closed);
});

test('destroy_disposes', async () => {
  const { relay, sockets, ports } = harness();
  const wc = webContents();
  await relay.open(wc);
  wc.emit('destroyed');
  assert.ok(sockets[0].closed);
  assert.equal(ports[0].isClosed, true);
  assert.equal(ports[0].posted.length, 0);
});

test('close_all_resume', async () => {
  const { relay, sockets, ports } = harness();
  const wc = webContents();
  await relay.open(wc);
  relay.closeAll('network changed');
  assert.equal(sockets[0].closed.code, CLOSE_ALL_CODE);
  assert.deepEqual(ports[0].posted, [{ t: 'closed', code: CLOSE_ALL_CODE, reason: 'network changed' }]);
  await relay.open(wc);
  assert.equal(sockets[1].closed, null);
  assert.equal(wc.delivered.length, 2);
});

test('refused_upgrade_rejects', async () => {
  const { relay, sockets } = harness();
  harness.refuse = true;
  try {
    await assert.rejects(relay.open(webContents()), /HTTP 403/);
  } finally {
    harness.refuse = false;
  }
  assert.equal(sockets[0].terminated, true);
});

test('opens_when_core_lacks_window_scope', async () => {
  const { relay, sockets, logs } = harness({ scope: null });
  await relay.open(webContents(1));
  await relay.open(webContents(2));
  assert.equal(sockets.length, 2);
  assert.equal(logs.filter((line) => line.includes('core-lacks-window-scope')).length, 1);
});

test('server window gets two ports with the right role headers; role is sent on every socket', async () => {
  const { relay, headers } = harness({
      endpoints: [
        { slot: 'primary', url: 'ws://127.0.0.1:2/rpc', token: 'a', target: 'server', role: 'server:c1' },
        { slot: 'pc', url: 'ws://127.0.0.1:3/rpc', token: 'b', target: 'local', role: 'server:c1' },
      ],
  });
  const wc = webContents();
  await relay.open(wc, 'primary');
  await relay.open(wc, 'pc');
  assert.deepEqual(
    headers.map((h) => [h.url, h['Mixdog-Window-Role']]),
    [
      ['ws://127.0.0.1:2/rpc', 'server:c1'],
      ['ws://127.0.0.1:3/rpc', 'server:c1'],
    ]
  );
  assert.deepEqual(wc.delivered.map((d) => d.message.slot), ['primary', 'pc']);
  const local = harness();
  await local.relay.open(webContents());
  assert.equal(local.headers[0]['Mixdog-Window-Role'], 'main');
});

test('dispose closes everything and refuses new opens', async () => {
  const { relay, sockets } = harness();
  await relay.open(webContents());
  relay.dispose();
  assert.ok(sockets[0].closed);
  await assert.rejects(relay.open(webContents()), /closed/);
});
