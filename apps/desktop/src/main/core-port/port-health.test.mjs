// The real renderer port connector and the real main relay, joined by an in-memory port, under the real client's health machine: a
// probe's silence verdict needs the receipt that its write completed on main's socket, then a window, then main's barrier.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect } from '../../../../../packages/protocol-client/src/client.ts';
import { createPortConnector } from '../../renderer/core-direct/port-connector.ts';
import { CorePortRelay } from './relay.ts';

const options = JSON.parse(readFileSync(new URL('../../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8'));
const INTERVAL = 10_000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

class Timers {
  now = 1_000_000;
  next = 1;
  list = [];
  set = (run, ms) => {
    const id = this.next++;
    this.list.push({ id, due: this.now + ms, run });
    return id;
  };
  clear = (id) => {
    this.list = this.list.filter((t) => t.id !== id);
  };
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const t = this.list.filter((x) => x.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!t) break;
      this.clear(t.id);
      this.now = Math.max(this.now, t.due);
      t.run();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

/** A socket whose send completion the test holds. */
class Socket extends EventEmitter {
  _socket = new EventEmitter();
  writes = [];
  closed = null;
  failNext = false;
  send(text, done) {
    this.writes.push({ text, done });
    if (!done) return;
    if (this.failNext) {
      this.failNext = false;
      queueMicrotask(() => done(new Error('write failed')));
    }
  }
  complete(index = this.writes.length - 1) {
    this.writes[index].done?.();
  }
  close(code, reason) {
    this.closed ??= { code, reason };
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason ?? '')));
  }
  terminate() {}
}

function rig() {
  const socket = new Socket();
  const timers = new Timers();
  const listeners = [];
  const host = { addEventListener: (_t, l) => listeners.push(l) };
  // main's end of the in-memory port is gated: while `stalled`, what the renderer posts waits, as it does behind a busy main.
  const main = Object.assign(new EventEmitter(), { start() {}, isClosed: false });
  const gate = { stalled: false, queue: [] };
  const renderer = {
    onmessage: null,
    postMessage: (data) => {
      const deliver = () => main.emit('message', { data });
      if (gate.stalled) gate.queue.push(deliver);
      else queueMicrotask(deliver);
    },
    close() {},
  };
  main.postMessage = (data) => queueMicrotask(() => renderer.onmessage?.({ data }));
  main.close = () => {
    if (main.isClosed) return;
    main.isClosed = true;
    main.emit('close');
  };
  const relay = new CorePortRelay({
    endpointFor: async () => [{ slot: 'primary', url: 'ws://127.0.0.1:1/rpc', token: 't', target: 'local', role: 'main' }],
    coreWindowScope: async () => 1,
    createSocket: () => {
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
    createChannel: () => ({ port1: main, port2: renderer }),
    log() {},
  });
  const webContents = Object.assign(new EventEmitter(), {
    id: 1,
    postMessage: (_channel, message, [port]) => listeners.forEach((l) => l({ source: host, data: { type: 'mixdog-core-port', ...message }, ports: [port] })),
  });
  const bridge = { open: (o) => relay.open(webContents, o?.slot) };
  const connector = createPortConnector(bridge, host);
  const release = async () => {
    gate.stalled = false;
    for (const run of gate.queue.splice(0)) run();
    await settle();
  };
  const coreSends = (value) => socket.emit('message', Buffer.from(JSON.stringify(value)), false);
  const start = async () => {
    const connecting = connect({
      target: { id: 'local' },
      connector,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      clock: { sleep: () => Promise.resolve() },
      random: () => options.jitterUnit,
      ladder: options.ladder,
      health: { intervalMs: INTERVAL, windowMs: INTERVAL, gapMs: 20_000, now: () => timers.now, setTimer: timers.set, clearTimer: timers.clear },
    });
    for (let i = 0; i < 50 && socket.writes.length === 0; i++) await settle();
    const init = JSON.parse(socket.writes[0].text);
    socket.complete(0);
    coreSends({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 'i1' } });
    const client = await connecting;
    await settle();
    return client;
  };
  return { socket, timers, gate, release, coreSends, start, renderer, main };
}

/** Writes of the probe (a `thread/unsubscribe`) on the socket. */
const probeWrites = (socket) => socket.writes.map((w, index) => ({ index, text: typeof w.text === 'string' ? w.text : '' })).filter((w) => w.text.includes('thread/unsubscribe'));
const pendingRead = (client) => client.call('thread/read', { threadId: 't1', window: { lastItems: 1 } }).catch(() => undefined);

test('main\'s dispatch held past the window: no close; released but its socket completion held: no close; the receipt opens the window', async () => {
  const r = rig();
  const client = await r.start();
  r.gate.stalled = true; // main does not get to what the renderer posts
  void pendingRead(client);
  await settle();
  await r.timers.advance(INTERVAL); // the heartbeat: the probe is posted to main
  await r.timers.advance(INTERVAL * 6);
  assert.equal(r.socket.closed, null, 'a main that has not written is not a silent core');
  const before = r.socket.writes.length;
  await r.release();
  assert.ok(r.socket.writes.length > before, 'main wrote the held frames');
  await r.timers.advance(INTERVAL * 6);
  assert.equal(r.socket.closed, null, 'main wrote but its socket has not completed the write: still no window');
  const probe = probeWrites(r.socket).at(-1);
  assert.ok(probe, 'the probe reached the socket');
  r.socket.complete(probe.index);
  await settle();
  await r.timers.advance(INTERVAL - 1);
  assert.equal(r.socket.closed, null, 'the window has not ended');
  await r.timers.advance(1);
  await r.timers.advance(1);
  assert.equal(r.socket.closed?.reason, 'window closed the port', 'a valid silent window after the receipt ends the link');
  await client.close();
});

test('main stalled after the acknowledgement with the barrier pending: no verdict until main has settled', async () => {
  const r = rig();
  const client = await r.start();
  void pendingRead(client);
  await settle();
  await r.timers.advance(INTERVAL);
  const probe = probeWrites(r.socket).at(-1);
  r.socket.complete(probe.index);
  await settle();
  r.gate.stalled = true; // main stops taking what the renderer posts: the barrier question waits behind it
  await r.timers.advance(INTERVAL + 5_000);
  assert.equal(r.socket.closed, null, 'the window ended but the receive barrier has not');
  await r.release();
  await settle();
  assert.equal(r.socket.closed?.reason, 'window closed the port', 'once main settled and nothing came, the verdict follows');
  await client.close();
});

test('main settled with progress waiting behind the barrier: the verdict is withheld and the link lives', async () => {
  const r = rig();
  const client = await r.start();
  void pendingRead(client);
  await settle();
  await r.timers.advance(INTERVAL);
  r.socket.complete(probeWrites(r.socket).at(-1).index);
  await settle();
  r.gate.stalled = true;
  await r.timers.advance(INTERVAL);
  r.socket._socket.emit('data', Buffer.from('bytes of the core\'s answer, still arriving')); // main saw them; the note is ahead of the barrier
  await settle();
  await r.release();
  await r.timers.advance(INTERVAL * 3);
  assert.equal(r.socket.closed, null, 'bytes that arrived before the barrier settled are progress');
  await client.close();
});

test('a socket write that fails is not a receipt: no window, and the probe is asked again', async () => {
  const r = rig();
  const client = await r.start();
  void pendingRead(client);
  await settle();
  r.socket.failNext = true;
  await r.timers.advance(INTERVAL);
  await r.timers.advance(INTERVAL * 5);
  assert.equal(r.socket.closed, null, 'a failed write is no evidence of a silent core');
  assert.ok(probeWrites(r.socket).length >= 2, 'the probe was asked again');
  await client.close();
});

test('the port closing before the acknowledgement never counts the write as sent', async () => {
  const r = rig();
  const client = await r.start();
  void pendingRead(client);
  await settle();
  await r.timers.advance(INTERVAL);
  const probe = probeWrites(r.socket).at(-1);
  r.socket.emit('close', 1006, Buffer.from(''));
  await settle();
  r.socket.complete(probe.index); // the write completes after the link is gone: nobody is told, and no window starts anywhere
  await settle();
  await r.timers.advance(INTERVAL * 6);
  assert.equal(r.socket.closed, null, 'nothing closes a socket that is already gone');
  await client.close();
});
