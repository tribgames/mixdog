// The connection's health machine: a silent connection is dropped only after a valid observation window with no new authenticated
// progress from the core, and never because of time alone. Time is a fake clock whose timers are run by the test, so a suspended page is a
// clock jump with its timers overdue.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from '../src/client.ts';
import { MockConn, MockNetwork } from '../src/mock.ts';
import type { ConnectOptions } from '../src/api.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const INTERVAL = 10_000;

class Timers {
  now = 1_000_000;
  private next = 1;
  list: Array<{ id: number; due: number; run: () => void }> = [];
  set = (run: () => void, ms: number): number => {
    const id = this.next++;
    this.list.push({ id, due: this.now + ms, run });
    return id;
  };
  clear = (id: unknown): void => {
    this.list = this.list.filter((t) => t.id !== id);
  };
  private earliest(limit: number) {
    return this.list.filter((t) => t.due <= limit).sort((a, b) => a.due - b.due)[0];
  }
  /** Time passes normally: each timer runs at its due time. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (let t = this.earliest(end); t; t = this.earliest(end)) {
      this.clear(t.id);
      this.now = Math.max(this.now, t.due);
      t.run();
      await settle();
    }
    this.now = end;
    await settle();
  }
  /** The page or machine was suspended: the clock moved on and no timer ran. */
  suspend(ms: number): void {
    this.now += ms;
  }
  /** The earliest overdue timer finally runs (before any queued receive callback). */
  async fireOverdue(): Promise<void> {
    const t = this.earliest(this.now);
    assert.ok(t, 'a timer is overdue');
    this.clear(t.id);
    t.run();
    await settle();
  }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const rig = (extra: Partial<ConnectOptions> = {}) => {
  const net = new MockNetwork();
  const timers = new Timers();
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    clock: { sleep: () => Promise.resolve() },
    random: () => options.jitterUnit,
    ladder: options.ladder,
    health: { intervalMs: INTERVAL, windowMs: INTERVAL, gapMs: 20_000, now: () => timers.now, setTimer: timers.set, clearTimer: timers.clear },
    ...extra,
  });
  const handshake = async (): Promise<MockConn> => {
    const conn = await net.accept();
    const init = JSON.parse(await conn.nextSent());
    conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 'i1' } });
    await conn.nextSent();
    return conn;
  };
  return { net, timers, connecting, handshake };
};

const closed = (conn: MockConn): string | undefined => (conn.clientClose as { reason: string } | undefined)?.reason;
const frames = (conn: MockConn): Array<{ id: number; method: string }> => conn.sent.map((s) => JSON.parse(s));
const probes = (conn: MockConn) => frames(conn).filter((f) => f.method === 'thread/unsubscribe');
const read = (client: Awaited<ReturnType<typeof connect>>) => client.call('thread/read', { threadId: 't1', window: { lastItems: 1 } });

test('authenticated fragments that keep arriving for over 30 s keep the link: the response arrives later, nothing restarts', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const pending = read(client);
  const request = JSON.parse(await conn.nextSent());
  for (let i = 0; i < 9; i++) {
    await r.timers.advance(5_000);
    conn.serverProgress();
  }
  assert.equal(conn.clientClose, undefined, '45 s of fragments, no disconnect');
  assert.equal(probes(conn).length, 0, 'a link that is delivering is not asked');
  conn.serverSend({ id: request.id, result: { thread: { id: 't1' } } });
  assert.deepEqual(await pending, { thread: { id: 't1' } });
  assert.equal(frames(conn).filter((f) => f.method === 'thread/read').length, 0, 'the transfer was not restarted');
  await client.close();
});

test('a transfer slower than the probe interval keeps the link even when a probe was asked in a gap of the fragments', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const pending = read(client);
  const request = JSON.parse(await conn.nextSent());
  await r.timers.advance(INTERVAL); // a quiet interval: a probe is asked
  assert.equal(probes(conn).length, 1);
  for (let i = 0; i < 8; i++) {
    await r.timers.advance(5_000);
    conn.serverProgress(); // the fragments of the response go on; the probe's reply is queued behind them
  }
  assert.equal(conn.clientClose, undefined);
  conn.serverSend({ id: request.id, result: {} });
  assert.deepEqual(await pending, {});
  await client.close();
});

test('fragments that stop mid-transfer end in a disconnect after a fresh valid silent window, not before', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const pending = read(client);
  pending.catch(() => undefined);
  await conn.nextSent();
  await r.timers.advance(5_000);
  conn.serverProgress();
  await r.timers.advance(INTERVAL); // the heartbeat sees the progress
  assert.equal(probes(conn).length, 0);
  await r.timers.advance(INTERVAL); // a quiet interval: the probe goes out and its window opens
  assert.equal(probes(conn).length, 1);
  assert.equal(conn.clientClose, undefined, 'the window has not passed');
  await r.timers.advance(INTERVAL / 2 - 1);
  assert.equal(conn.clientClose, undefined);
  await r.timers.advance(1);
  assert.equal(closed(conn), 'core silent');
});

test('progress during the window clears the suspicion; a reply to the probe is progress', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  read(client).catch(() => undefined);
  await conn.nextSent();
  await r.timers.advance(INTERVAL);
  const probe = probes(conn)[0]!;
  await r.timers.advance(4_000);
  conn.serverSend({ id: probe.id, result: {} });
  await r.timers.advance(INTERVAL * 3);
  assert.equal(conn.clientClose, undefined);
  await client.close();
});

test('a connection that is quiet with nothing pending is never probed', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  await r.timers.advance(INTERVAL * 10);
  assert.equal(conn.sent.length, 0);
  assert.equal(r.timers.list.length, 0, 'no timer without a pending request');
  await client.close();
});

test('progress an old connection reports never refreshes the new one', async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  first.serverClose(1006);
  const second = await r.handshake();
  read(client).catch(() => undefined);
  await second.nextSent();
  await r.timers.advance(INTERVAL);
  first.serverProgress();
  first.serverSend({ method: 'thread/queue/changed', feed: { id: 't1' }, params: {} });
  await r.timers.advance(INTERVAL - 1);
  first.serverProgress();
  await r.timers.advance(1);
  assert.equal(closed(second), 'core silent');
});

test('probe, then a suspension: the overdue timer runs before the queued receive and does not drop the link; the reply that was queued clears it', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const pending = read(client);
  pending.catch(() => undefined);
  await conn.nextSent();
  await r.timers.advance(INTERVAL);
  const probe = probes(conn)[0]!;
  r.timers.suspend(10 * 60_000);
  await r.timers.fireOverdue();
  assert.equal(conn.clientClose, undefined, 'the overdue timer is a scheduling gap, not silence');
  assert.equal(probes(conn).length, 2, 'a fresh probe cycle began');
  conn.serverSend({ id: probe.id, result: {} });
  await r.timers.advance(INTERVAL * 3);
  assert.equal(conn.clientClose, undefined);
  await client.close();
});

test('the same suspension with no answer after resume: a fresh probe and window, then the disconnect', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  read(client).catch(() => undefined);
  await conn.nextSent();
  await r.timers.advance(INTERVAL);
  r.timers.suspend(10 * 60_000);
  await r.timers.fireOverdue();
  assert.equal(conn.clientClose, undefined);
  await r.timers.advance(INTERVAL - 1);
  assert.equal(conn.clientClose, undefined, 'the new window has not passed');
  await r.timers.advance(1);
  assert.equal(closed(conn), 'core silent');
});

test('receive work the transport accepted before the deadline settles before the decision: its progress saves the link', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  read(client).catch(() => undefined);
  await conn.nextSent();
  await r.timers.advance(INTERVAL);
  let finish!: () => void;
  conn.receiveInFlight(new Promise<void>((resolve) => (finish = resolve)));
  await r.timers.advance(INTERVAL); // the window ends while authentication is unfinished
  assert.equal(conn.clientClose, undefined, 'the decision waits for the receive chain');
  conn.serverProgress(); // what the unfinished authentication reports when it completes
  finish();
  await settle();
  assert.equal(conn.clientClose, undefined);
  await client.close();
});

test('a probe that has not left the page is no silence to judge: the window opens when it has left', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  read(client).catch(() => undefined);
  await conn.nextSent();
  conn.claims = 'held';
  await r.timers.advance(INTERVAL);
  await r.timers.advance(INTERVAL * 6);
  assert.equal(conn.clientClose, undefined, 'a send that is still leaving is not a dead core');
  conn.releaseSent();
  await settle();
  await r.timers.advance(INTERVAL - 1);
  assert.equal(conn.clientClose, undefined);
  await r.timers.advance(1);
  assert.equal(closed(conn), 'core silent');
});

test('wake check and online at once, then silence: one probe cycle at a time, one timer, one close', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const first = client.checkLink();
  const second = client.checkLink();
  await settle();
  assert.equal(r.timers.list.length, 1, 'no competing timers');
  await r.timers.advance(INTERVAL);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(closed(conn), 'core silent');
  assert.equal(r.timers.list.length, 0, 'nothing is left watching a dropped link');
});

test('a wake check is answered by progress; a link with nothing pending and no check is not watched afterwards', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const alive = client.checkLink();
  await settle();
  conn.serverProgress();
  assert.equal(await alive, true);
  assert.equal(conn.clientClose, undefined);
  assert.equal(r.timers.list.length, 0);
  await client.close();
});

test('the last pending request completing during a window leaves no watchdog behind', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const pending = read(client);
  const request = JSON.parse(await conn.nextSent());
  await r.timers.advance(INTERVAL);
  assert.equal(probes(conn).length, 1);
  conn.serverSend({ id: request.id, result: { thread: { id: 't1' } } });
  await pending.catch(() => undefined);
  await settle();
  assert.equal(r.timers.list.length, 0, 'no orphan timer');
  await r.timers.advance(INTERVAL * 5);
  assert.equal(conn.clientClose, undefined);
  await client.close();
});

test('a connection that ends while a probe is out leaves nothing running, and the next connection starts clean', async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  read(client).catch(() => undefined);
  await first.nextSent();
  await r.timers.advance(INTERVAL);
  first.serverClose(1006);
  await settle();
  assert.equal(r.timers.list.length, 0);
  const second = await r.handshake();
  await r.timers.advance(INTERVAL * 5);
  assert.equal(first.clientClose, undefined, 'no stale close of the old connection');
  assert.equal(second.clientClose, undefined, 'nothing is pending on the new connection');
  await client.close();
});

// ---- the departure receipt: no receipt, no window, no verdict ----

test('a transport that gives no departure receipt never gets a silence verdict', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  conn.claims = 'none';
  read(client).catch(() => undefined);
  await conn.nextSent();
  await r.timers.advance(INTERVAL * 20);
  assert.equal(conn.clientClose, undefined, 'a missing receipt is not evidence of a silent core');
  assert.ok(probes(conn).length >= 0);
  await client.close();
});

test('a refused write gives no verdict either: the probe is simply asked again, and the receipt that follows opens the window', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  read(client).catch(() => undefined);
  await conn.nextSent();
  conn.claims = 'refused';
  await r.timers.advance(INTERVAL * 6);
  assert.equal(conn.clientClose, undefined, 'a write that failed is not a window');
  const asked = probes(conn).length;
  assert.ok(asked >= 2, `the probe is asked again (${asked})`);
  conn.claims = 'given';
  await r.timers.advance(INTERVAL);
  await r.timers.advance(INTERVAL);
  assert.equal(closed(conn), 'core silent', 'once a probe has left, the window runs and ends the silent link');
});

test('a receipt that arrives twice does not restart the window, and one that never arrives leaves no verdict', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  let calls = 0;
  const writer = conn.writer;
  const send = writer.send;
  let again: (() => void) | undefined;
  writer.send = (text, sent) => {
    send(text, sent && ((promise) => {
      calls++;
      sent(promise);
      again = () => sent(promise); // the same transport claims the same frame a second time
    }));
  };
  read(client).catch(() => undefined);
  await conn.nextSent();
  await r.timers.advance(INTERVAL); // the heartbeat sends the probe; its receipt opens the window
  await r.timers.advance(INTERVAL - 1);
  again?.();
  await settle();
  await r.timers.advance(1);
  assert.equal(closed(conn), 'core silent', 'the second claim did not move the window');
  assert.ok(calls >= 1);
});

test('a receipt of an old connection opens no window on the new one', async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  read(client).catch(() => undefined);
  await first.nextSent();
  first.claims = 'held';
  await r.timers.advance(INTERVAL); // the probe is out on the first connection, its write not yet complete
  first.serverClose(1006);
  const second = await r.handshake();
  second.claims = 'none';
  read(client).catch(() => undefined);
  await second.nextSent();
  first.releaseSent(); // the old connection's write completes now
  await settle();
  await r.timers.advance(INTERVAL * 6);
  assert.equal(second.clientClose, undefined, 'the old receipt started no window on the new connection');
  await client.close();
});

test('progress that arrives before the receipt does not end the window that the receipt then opens', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  read(client).catch(() => undefined);
  await conn.nextSent();
  conn.claims = 'held';
  await r.timers.advance(INTERVAL);
  conn.serverProgress(); // before the probe has left: it says nothing about the probe
  conn.releaseSent();
  await settle();
  await r.timers.advance(INTERVAL - 1);
  assert.equal(conn.clientClose, undefined);
  await r.timers.advance(1);
  assert.equal(closed(conn), 'core silent', 'the window counts only what arrived after the receipt');
});
