import assert from 'node:assert/strict';
import test from 'node:test';
import { createPortConnector } from './port-connector.ts';

function fakePort() {
  const port = { onmessage: null, sent: [], closed: false, postMessage(d) { port.sent.push(d); }, close() { port.closed = true; } };
  return port;
}
function setup(timeoutMs = 50) {
  const listeners = [];
  const host = { addEventListener: (_t, l) => listeners.push(l) };
  let next = 1;
  const bridge = { opened: [], async open(o) { bridge.opened.push(o); return { generation: next++ }; } };
  const deliver = (port, { generation, slot, source = host, type = 'mixdog-core-port' }) =>
    listeners.forEach((l) => l({ source, data: { type, generation, slot }, ports: [port] }));
  const sink = { frames: [], closes: [], frame(t) { sink.frames.push(t); }, closed(c, r) { sink.closes.push([c, r]); } };
  return { connector: createPortConnector(bridge, host, timeoutMs), bridge, deliver, sink };
}
const tick = () => new Promise((r) => setImmediate(r));

test('frames_both_ways', async () => {
  const { connector, deliver, sink } = setup();
  const port = fakePort();
  const p = connector.open({ id: 'local' }, sink);
  await tick();
  deliver(port, { generation: 1 });
  const writer = await p;
  port.onmessage({ data: '{"a":1}' });
  assert.deepEqual(sink.frames, ['{"a":1}']);
  writer.send('hi');
  assert.deepEqual(port.sent, ['hi']);
  writer.close(1000, 'bye');
  assert.deepEqual(port.sent[1], { t: 'close', code: 1000, reason: 'bye' });
  assert.equal(port.closed, true);
});

test('closed_once', async () => {
  const { connector, deliver, sink } = setup();
  const port = fakePort();
  deliver(port, { generation: 1 });
  await connector.open({ id: 'local' }, sink);
  port.onmessage({ data: { t: 'closed', code: 4001, reason: 'x' } });
  port.onmessage({ data: { t: 'closed', code: 4002, reason: 'y' } });
  assert.deepEqual(sink.closes, [[4001, 'x']]);
});

test('foreign_source_ignored', async () => {
  const { connector, deliver, sink } = setup(30);
  const port = fakePort();
  const p = connector.open({ id: 'local' }, sink);
  await tick();
  deliver(port, { generation: 1, source: {} });
  await assert.rejects(p, /did not arrive/);
});

test('take_timeout_rejects', async () => {
  const { connector, sink } = setup(20);
  await assert.rejects(connector.open({ id: 'local' }, sink), /did not arrive/);
});

test('stale_generation_dropped', async () => {
  const { connector, deliver, sink } = setup(30);
  const fresh = fakePort();
  const stale = fakePort();
  deliver(fresh, { generation: 5 });
  deliver(stale, { generation: 4 });
  assert.equal(stale.closed, true);
  assert.equal(fresh.closed, false);
  const older = fakePort();
  deliver(older, { generation: 5, slot: 'pc' });
  deliver(fakePort(), { generation: 6, slot: 'pc' });
  assert.equal(older.closed, true);
  // the bridge hands out generation 1, which was never delivered
  await assert.rejects(connector.open({ id: 'local' }, sink), /did not arrive/);
});

test('pc target asks for the pc slot', async () => {
  const { connector, bridge, deliver, sink } = setup();
  const port = fakePort();
  const p = connector.open({ id: 'pc' }, sink);
  await tick();
  deliver(port, { generation: 1, slot: 'pc' });
  await p;
  assert.deepEqual(bridge.opened, [{ slot: 'pc' }]);
});
