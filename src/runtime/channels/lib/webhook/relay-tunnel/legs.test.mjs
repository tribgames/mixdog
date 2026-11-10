import assert from 'node:assert/strict';
import { test } from 'node:test';

import { armLegHeartbeat } from './leg-heartbeat.mjs';
import { HEARTBEAT_MS } from './limits.mjs';
import { respondOverLeg } from './local-forward.mjs';

// The leg is a `ws` socket; its ready-state constants live on the socket, so
// neither module may depend on a global WebSocket being defined.
function withoutGlobalWebSocket(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  delete globalThis.WebSocket;
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'WebSocket', descriptor);
  });
}

function fakeLeg(readyState = 1) {
  const handlers = {};
  return {
    readyState,
    OPEN: 1,
    sent: [],
    pings: 0,
    on(event, handler) {
      handlers[event] = handler;
    },
    send(frame) {
      this.sent.push(JSON.parse(frame));
    },
    ping() {
      this.pings += 1;
    },
    terminate() {},
  };
}

test('responses go out over an open leg and are dropped on a closed one', (t) => {
  withoutGlobalWebSocket(t);
  const open = fakeLeg(1);
  respondOverLeg(open, 'r1', 200, { 'content-type': 'text/plain' }, Buffer.from('ok'));
  assert.deepEqual(open.sent, [
    { type: 'http-response', id: 'r1', status: 200, headers: { 'content-type': 'text/plain' }, body: 'b2s=' },
  ]);
  const closed = fakeLeg(3);
  respondOverLeg(closed, 'r2', 200, {}, null);
  assert.deepEqual(closed.sent, []);
});

test('the heartbeat pings an open leg', (t) => {
  withoutGlobalWebSocket(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const leg = fakeLeg(1);
  const heartbeat = armLegHeartbeat(leg);
  try {
    t.mock.timers.tick(HEARTBEAT_MS);
    assert.equal(leg.pings, 1);
  } finally {
    heartbeat.stop();
  }
});
