import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BootReports } from './boot-progress.ts';
import { CLOSE_ALL_CODE, CORE_BOOT_CHANNEL, CORE_PORT_CHANNEL, CorePortRelay } from './relay.ts';
import { windowIdFor } from './window-ids.ts';

/** Lines are written after the caller's own work (link-log.mjs): read them one turn later. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeSocket extends EventEmitter {
  _socket = new EventEmitter();
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
  return Object.assign(emitter, {
    id,
    delivered: [],
    postMessage(channel, message, transfer) {
      this.delivered.push({ channel, message, transfer });
    },
  });
}

function harness({ scope = 1, endpoints } = {}) {
  const sockets = [];
  const headers = [];
  const ports = [];
  const logs = [];
  const diags = [];
  const all = endpoints ?? [
    { slot: 'primary', url: 'ws://127.0.0.1:1/rpc', token: 'tok', target: 'local', role: 'main' },
  ];
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
    diagnostic: (event, fields) => diags.push({ event, ...fields }),
  });
  return { relay, sockets, headers, ports, logs, diags };
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

test('a link that the core ends is written to the diagnostics with its code, reason and age, and the next open is a reconnect, not a replacement', async () => {
  const { relay, sockets, diags } = harness();
  const wc = webContents();
  const first = await relay.open(wc);
  sockets[0].emit('close', 4001, Buffer.from('pingDeadline'));
  await flush();
  const close = diags.find((d) => d.event === 'core-link-close');
  assert.equal(close.code, 4001);
  assert.equal(close.reason, 'pingDeadline');
  assert.equal(close.generation, first.generation);
  assert.equal(close.initiator, 'core-or-network');
  assert.equal(typeof close.openMs, 'number');
  await relay.open(wc);
  const opens = diags.filter((d) => d.event === 'core-link-open');
  assert.deepEqual(
    opens.map((d) => d.replaced),
    [false, false]
  );
});

test('a link ended by a newer open is written as closed by the desktop, and the newer open says it replaced a live link', async () => {
  const { relay, diags } = harness();
  const wc = webContents();
  await relay.open(wc);
  await relay.open(wc);
  await flush();
  const close = diags.find((d) => d.event === 'core-link-close');
  assert.equal(close.initiator, 'desktop');
  assert.equal(close.reason, 'superseded');
  assert.deepEqual(
    diags.filter((d) => d.event === 'core-link-open').map((d) => d.replaced),
    [false, true]
  );
});

test("a channel that cannot be created after the socket opened still leaves the link's close line, from the desktop", async () => {
  const { diags } = harness();
  const failing = new CorePortRelay({
    coreWindowScope: async () => 1,
    endpointFor: async () => [{ slot: 'primary', url: 'ws://x', token: 't', role: 'main', target: { id: 'core' } }],
    createSocket: () => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    createChannel: () => {
      throw new Error('no channel');
    },
    diagnostic: (event, fields) => diags.push({ event, ...fields }),
    log: () => {},
  });
  await assert.rejects(failing.open(webContents()), /no channel/);
  await flush();
  const close = diags.filter((d) => d.event === 'core-link-close');
  assert.equal(close.length, 1);
  assert.equal(close[0].initiator, 'desktop');
  assert.match(close[0].reason, /no channel/);
});

test('a socket the core closes while the channel is still being created leaves one close line from the core side', async () => {
  const { diags } = harness();
  let socket;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const relay = new CorePortRelay({
    coreWindowScope: async () => 1,
    endpointFor: async () => [{ slot: 'primary', url: 'ws://x', token: 't', role: 'main', target: { id: 'core' } }],
    createSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    createChannel: async () => {
      await gate;
      return { port1: new FakePort(), port2: {} };
    },
    diagnostic: (event, fields) => diags.push({ event, ...fields }),
    log: () => {},
  });
  const opening = relay.open(webContents());
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('close', 4001, Buffer.from('pingDeadline'));
  release();
  await opening;
  await flush();
  const close = diags.filter((d) => d.event === 'core-link-close');
  assert.equal(close.length, 1);
  assert.equal(close[0].initiator, 'core-or-network');
  assert.equal(close[0].code, 4001);
});

test("a close the window asks for is written as the window's, once, not as the core's or network's", async () => {
  const { relay, ports, sockets, diags } = harness();
  await relay.open(webContents());
  ports[0].emit('message', { data: { t: 'close' } });
  await flush();
  const close = diags.filter((d) => d.event === 'core-link-close');
  assert.equal(close.length, 1);
  assert.equal(close[0].initiator, 'window');
  assert.equal(close[0].reason, 'window closed the port');
  await new Promise((resolve) => setImmediate(resolve)); // the socket's own close event follows
  assert.equal(diags.filter((d) => d.event === 'core-link-close').length, 1);
  assert.equal(sockets[0].closed.reason, 'window closed the port');
});

test('a throwing diagnostics sink does not break opening or closing a link', async () => {
  const throwing = new CorePortRelay({
    coreWindowScope: async () => 1,
    endpointFor: async () => [{ slot: 'primary', url: 'ws://x', token: 't', role: 'main', target: { id: 'core' } }],
    createSocket: () => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    createChannel: () => ({ port1: new FakePort(), port2: {} }),
    diagnostic: () => {
      throw new Error('sink failed');
    },
    log: () => {},
  });
  const wc = webContents();
  assert.equal(typeof (await throwing.open(wc)).generation, 'number');
  throwing.closeAll('test');
});

test('an open superseded before its port is delivered rejects and delivers nothing', async () => {
  const { relay, sockets, ports } = harness();
  const wc = webContents();
  const stale = relay.open(wc);
  const fresh = relay.open(wc);
  await assert.rejects(stale, /superseded/);
  const { generation } = await fresh;
  assert.deepEqual(
    wc.delivered.map((d) => d.message.generation),
    [generation]
  );
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
  assert.deepEqual(
    wc.delivered.map((d) => d.message.slot),
    ['primary', 'pc']
  );
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
test('progress: bytes arriving on the core socket reach the window as progress notes, and not once the link has ended', async () => {
  const { relay, sockets, ports } = harness();
  await relay.open(webContents());
  const note = { t: 'progress' };
  sockets[0]._socket.emit('data', Buffer.from('part of a large response'));
  assert.deepEqual(ports[0].posted, [note]);
  sockets[0]._socket.emit('data', Buffer.alloc(0));
  assert.equal(ports[0].posted.length, 1, 'an empty read is not progress');
  sockets[0].emit('close', 1006, Buffer.from(''));
  await flush();
  const before = ports[0].posted.length;
  sockets[0]._socket.emit('data', Buffer.from('late'));
  assert.equal(ports[0].posted.length, before, 'nothing is reported after the link ended');
});

function reporting({ endpointFor } = {}) {
  const reports = new BootReports();
  const relay = new CorePortRelay({
    bootReports: reports,
    endpointFor:
      endpointFor ??
      (async () => [{ slot: 'primary', url: 'ws://127.0.0.1:1/rpc', token: 'tok', target: 'local', role: 'main' }]),
    coreWindowScope: async () => 1,
    createSocket: () => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    createChannel: () => ({ port1: new FakePort(), port2: {} }),
    log: () => {},
  });
  const window = (id = 1) => {
    const wc = webContents(id);
    wc.told = [];
    wc.send = (channel, message) => wc.told.push({ channel, message });
    return wc;
  };
  return { reports, relay, window };
}

test('boot reports: a window waiting for its core is told the rebuild as it advances, and nothing once its open has ended', async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const { reports, relay, window } = reporting({
    endpointFor: async () => {
      await wait;
      return [{ slot: 'primary', url: 'ws://127.0.0.1:1/rpc', token: 'tok', target: 'local', role: 'main' }];
    },
  });
  const attempt = reports.attempt();
  attempt.progress({ done: 10, total: 100 }, 7);
  const wc = window();
  const opening = relay.open(wc);
  await flush();
  assert.deepEqual(
    wc.told,
    [{ channel: CORE_BOOT_CHANNEL, message: { progress: { done: 10, total: 100, boot: 7 }, failure: null } }],
    'what is known when the open begins'
  );
  attempt.progress({ done: 60, total: 100 }, 7);
  assert.deepEqual(wc.told.at(-1).message.progress, { done: 60, total: 100, boot: 7 });
  attempt.succeeded();
  assert.equal(wc.told.at(-1).message.progress, null, 'the end of the attempt clears it');
  release();
  await opening;
  const told = wc.told.length;
  reports.attempt().progress({ done: 1, total: 2 }, 7);
  assert.equal(wc.told.length, told, 'not told once the port is delivered');
});

test('boot reports: a normal start tells the window nothing', async () => {
  const { relay, window } = reporting();
  const wc = window();
  await relay.open(wc);
  assert.deepEqual(wc.told, []);
});

test('boot reports: an open that a newer open superseded, or whose window is destroyed, stops listening at once and never sends', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { reports, relay, window } = reporting({
    endpointFor: async () => {
      await gate;
      return [{ slot: 'primary', url: 'ws://x', token: 't', target: 'local', role: 'main' }];
    },
  });
  const wc = window();
  const first = relay.open(wc).catch((error) => error);
  await flush();
  const attempt = reports.attempt();
  attempt.progress({ done: 1, total: 4 }, 7);
  assert.equal(wc.told.length, 1, 'the live open is told');
  const second = relay.open(wc);
  await flush();
  const before = wc.told.length;
  attempt.progress({ done: 2, total: 4 }, 7);
  // Two listeners would be told twice; the superseded one is ended with its entry and never sends.
  assert.equal(wc.told.length, before + 1, 'one send for one change: the superseded open is not listening');
  const gone = window(2);
  const pending = relay.open(gone).catch(() => {});
  await flush();
  gone.emit('destroyed');
  const told = gone.told.length;
  attempt.progress({ done: 3, total: 4 }, 7);
  assert.equal(gone.told.length, told, 'a destroyed window is not told');
  release();
  await Promise.all([first, second, pending]);
});

test('boot reports: a start that fails the same way twice reaches the waiting window before its open rejects', async () => {
  const exit = (path) =>
    Object.assign(new Error('core is not ready: the core ended before serving (exited with code 2): no manifest'), {
      coreExit: { code: 2, signal: null, stderrPath: path },
    });
  const reports = new BootReports();
  const relay = new CorePortRelay({
    bootReports: reports,
    endpointFor: async () => {
      const attempt = reports.attempt();
      throw attempt.failed(exit(`p${Math.random()}`));
    },
    coreWindowScope: async () => 1,
    log: () => {},
  });
  const wc = webContents();
  wc.told = [];
  wc.send = (channel, message) => wc.told.push({ channel, message });
  await assert.rejects(relay.open(wc), /no manifest/, 'the first end is an ordinary failure');
  assert.equal(wc.told.length, 0);
  const second = await relay.open(wc);
  assert.deepEqual(Object.keys(second), ['launchFailed'], 'the answer is an explicit result, not a rejection');
  assert.equal(second.launchFailed.exitCode, 2);
  assert.match(wc.told.at(-1).message.failure.message, /exited with code 2/);
});

test('boot reports: an error whose text happens to say what a terminal answer says is still an error', async () => {
  const relay = new CorePortRelay({
    endpointFor: async () => {
      throw new Error('stderr: mixdog-core-launch-failed: something');
    },
    coreWindowScope: async () => 1,
    log: () => {},
  });
  await assert.rejects(relay.open(webContents()), /mixdog-core-launch-failed/);
});
