#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-lane-backlog.test.mjs (b6f10295a): a backed-up session stream still delivers a lane the
// desktop decoder can apply. The real session frame stream (src/standalone/session-frame-stream.mjs createSessionFrameStream) with an
// SSE response whose attach write back-pressures, the service's snapshot delta encoder (prepend, partialAppend) and the main-process decoder.
// The stream's setInterval is mocked (node:test mock timers) exactly as the test did; the writes it made are recorded in order.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-lane-backlog-cases.mjs --tree <export of b6f10295a with node_modules>
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-lane-backlog-cases', import.meta.url);
const { createSessionFrameStream } = await set.load('src/standalone/session-frame-stream.mjs');
const { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder } = await set.load('apps/desktop/src/main/state-delta.ts');

await set.run('a backed-up session stream still delivers a lane the desktop decoder can apply', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
    const stream = createSessionFrameStream({ clients: new Map([['client', client]]), maxPendingBytes: 8 * 1024 * 1024, nowMs: () => 1_000, onAttached() {}, onClosed() {} });
    const writes = [];
    const response = Object.assign(new EventEmitter(), {
      writeHead(...args) { writes.push({ writeHead: args }); },
      write(value) { writes.push(value); return writes.filter((w) => typeof w === 'string').length > 1; },
      end() { this.emit('close'); },
    });
    stream.attachSse('client', response);
    const encoder = createSnapshotDeltaEncoder({ prepend: true, partialAppend: true });
    const publish = (snapshot) => stream.broadcast({ type: 'desktop-event', key: 'desktop-event:desktop:session-state:S', desktopId: 'desktop', message: { kind: 'session-state', sessionId: 'S', wire: encoder.encode(snapshot) } });
    const opened = { items: [{ id: 'a', text: 'x'.repeat(300_000) }], title: 'open' };
    publish(opened);
    const afterOpen = writes.length;
    publish({ ...opened, items: [...opened.items, { id: 'b', text: 'live' }] });
    const afterLive = writes.length;
    response.emit('drain');
    const decoder = createSnapshotDeltaDecoder();
    const events = writes.filter((w) => typeof w === 'string').flatMap((value) => value.split('\n\n')).filter((event) => event.startsWith('data:'));
    const decoded = events.map((event) => decoder.decode(JSON.parse(event.slice(6)).message.wire));
    response.end();
    return { openedItemChars: 300_000, maxPendingBytes: 8 * 1024 * 1024, writesAfterOpen: afterOpen, writesAfterLive: afterLive, writesTotal: writes.length, writes, decoded };
  } finally { mock.timers.reset(); }
});

await set.finish({
  entry: { runs: 'createSessionFrameStream (attachSse, broadcast, drain handling) with a scripted SSE response (EventEmitter; the first write returns true, later ones false when more than one string has been written), the snapshot delta encoder/decoder', notRun: 'no HTTP server; the stream\'s interval timer is the mocked one' },
  replay: { entry: 'mixdog-app-server thread feed (SSE frame stream under backlog): replay attach, the two session-state broadcasts and the drain; compare the writes in order, whole, and that each data event decodes to the recorded snapshot', normalised: {} },
});
process.exit(0);
