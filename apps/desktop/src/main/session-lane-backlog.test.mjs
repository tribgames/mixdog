import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSessionFrameStream } from '../../../../src/standalone/session-frame-stream.mjs';
import { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder } from './state-delta.ts';

test('a backed-up session stream still delivers a lane the desktop decoder can apply', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
  const stream = createSessionFrameStream({
    clients: new Map([['client', client]]),
    maxPendingBytes: 8 * 1024 * 1024,
    nowMs: () => 1_000,
    onAttached() {},
    onClosed() {},
  });
  const writes = [];
  const response = Object.assign(new EventEmitter(), {
    writeHead() {},
    // The attach write backpressures, so the lane below waits for drain.
    write(value) {
      writes.push(value);
      return writes.length > 1;
    },
    end() {
      this.emit('close');
    },
  });
  stream.attachSse('client', response);
  // The service's encoder for the main-process decoder.
  const encoder = createSnapshotDeltaEncoder({ prepend: true, partialAppend: true });
  const publish = (snapshot) =>
    stream.broadcast({
      type: 'desktop-event',
      key: 'desktop-event:desktop:session-state:S',
      desktopId: 'desktop',
      message: { kind: 'session-state', sessionId: 'S', wire: encoder.encode(snapshot) },
    });
  const opened = { items: [{ id: 'a', text: 'x'.repeat(300_000) }], title: 'open' };
  publish(opened);
  publish({ ...opened, items: [...opened.items, { id: 'b', text: 'live' }] });
  response.emit('drain');
  const decoder = createSnapshotDeltaDecoder();
  const decoded = writes
    .flatMap((value) => value.split('\n\n'))
    .filter((event) => event.startsWith('data:'))
    .map((event) => decoder.decode(JSON.parse(event.slice(6)).message.wire));
  assert.deepEqual(
    decoded.map((result) => result.ok),
    [true, true]
  );
  assert.deepEqual(
    decoded.at(-1).snapshot.items.map((item) => item.id),
    ['a', 'b']
  );
  response.end();
});
