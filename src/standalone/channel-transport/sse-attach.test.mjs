import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachClientStream } from './client-registry/sse-attach.mjs';

function fakeResponse() {
  const res = new EventEmitter();
  res.writes = [];
  res.writeHead = () => {};
  res.write = (chunk) => {
    res.writes.push(chunk);
    return true;
  };
  return res;
}

test('an attached loopback channel stream writes no keepalive while idle and releases the client on close', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const client = { sse: null, lastSeen: 0, pendingRemoteStateFrame: null };
  const res = fakeResponse();
  let closed = 0;
  attachClientStream({ client, res, stickyFrame: null, onClosed: () => closed++ });
  t.mock.timers.tick(120_000);
  assert.deepEqual(res.writes, [': attached\n\n']);
  res.emit('close');
  assert.equal(client.sse, null);
  assert.equal(closed, 1);
});
