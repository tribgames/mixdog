// The reviewer's case end to end: a probe has left, steady later traffic keeps the carrier's buffer above zero, and the core says
// nothing — the window still opens on the probe's own departure and the silent link is dropped. Not the whole buffer, this probe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect } from '../../../../packages/protocol-client/src/client.ts';
import { CarrierDeparture } from './remote-transport-peer.ts';

const options = JSON.parse(
  readFileSync(new URL('../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
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

function rig() {
  const timers = new Timers();
  // The carrier: bytes queued in front-to-back order; \`leave\` lets bytes out of the front.
  const buffer = { queued: 0, closed: null, texts: [] };
  const departure = new CarrierDeparture(
    () => buffer.queued,
    () => buffer.closed === null,
    { setTimeout: timers.set, clearTimeout: timers.clear }
  );
  let sink;
  const connector = {
    async open(_target, given) {
      sink = given;
      return {
        send(text, sent) {
          buffer.texts.push(text);
          buffer.queued += text.length;
          departure.enqueue(text.length);
          if (sent) sent(departure.since(departure.position()));
          const frame = JSON.parse(text);
          if (frame.method === 'initialize') {
            queueMicrotask(() =>
              sink.frame(
                JSON.stringify({ id: frame.id, result: { ...options.initializeResult, serverInstanceId: 'i1' } })
              )
            );
          }
        },
        close(code, reason) {
          buffer.closed = { code, reason };
        },
      };
    },
  };
  const start = async () => {
    const connecting = connect({
      target: { id: 'phone' },
      connector,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      clock: { sleep: () => Promise.resolve() },
      random: () => options.jitterUnit,
      ladder: options.ladder,
      health: {
        intervalMs: INTERVAL,
        windowMs: INTERVAL,
        gapMs: 20_000,
        now: () => timers.now,
        setTimer: timers.set,
        clearTimer: timers.clear,
      },
    });
    const client = await connecting;
    buffer.queued = 0; // the handshake has gone
    await settle();
    return client;
  };
  /** Other traffic of the page goes out behind everything already queued. */
  const traffic = (bytes) => {
    buffer.queued += bytes;
    departure.enqueue(bytes);
  };
  return { timers, buffer, departure, start, traffic };
}

test("a probe that has left opens its window although later traffic keeps the carrier's buffer above zero; a silent core is dropped", async () => {
  const r = rig();
  const client = await r.start();
  void client.call('thread/read', { threadId: 't1', window: { lastItems: 1 } }).catch(() => undefined);
  await settle();
  r.buffer.queued = 0; // the request has left
  await r.timers.advance(INTERVAL); // the heartbeat sends the probe
  const probeAt = r.buffer.texts.findIndex((text) => text.includes('thread/unsubscribe'));
  assert.ok(probeAt >= 0, 'the probe was written');
  const probeBytes = r.buffer.texts[probeAt].length;
  assert.equal(r.buffer.queued, probeBytes, 'only the probe is in the carrier');
  r.buffer.queued = 0; // the probe leaves the carrier ...
  for (let second = 0; second < 25; second++) {
    r.traffic(2_000); // ... while the page keeps sending: the buffer never reaches zero
    r.buffer.queued -= 1_000;
    await r.timers.advance(1_000);
  }
  assert.ok(r.buffer.queued > 0, 'the buffer stayed above zero');
  assert.equal(r.buffer.closed?.reason, 'core silent', 'the core said nothing: the link is dropped');
  await client.close();
});
