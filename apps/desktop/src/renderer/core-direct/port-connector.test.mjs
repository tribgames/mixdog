import assert from 'node:assert/strict';
import test from 'node:test';
import { createPortConnector } from './port-connector.ts';

function fakePort() {
  const port = {
    onmessage: null,
    sent: [],
    closed: false,
    postMessage(d) {
      port.sent.push(d);
    },
    close() {
      port.closed = true;
    },
  };
  return port;
}
function setup(timeoutMs = 50) {
  const listeners = [];
  const host = { addEventListener: (_t, l) => listeners.push(l) };
  let next = 1;
  const bridge = {
    opened: [],
    async open(o) {
      bridge.opened.push(o);
      return { generation: next++ };
    },
  };
  const deliver = (port, { generation, slot, source = host, type = 'mixdog-core-port' }) =>
    listeners.forEach((l) => {
      l({ source, data: { type, generation, slot }, ports: [port] });
    });
  const sink = {
    frames: [],
    closes: [],
    frame(t) {
      sink.frames.push(t);
    },
    closed(c, r) {
      sink.closes.push([c, r]);
    },
  };
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
  const { connector, deliver, sink } = setup(10_000);
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
  // the bridge hands out generation 1 after generation 5 already arrived: rejects immediately as superseded
  await assert.rejects(connector.open({ id: 'local' }, sink), /superseded by generation 5/);
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

async function opened(options) {
  const { connector, deliver, sink } = setup();
  const port = fakePort();
  const p = connector.open({ id: 'local' }, sink);
  await tick();
  deliver(port, { generation: options?.generation ?? 1 });
  return { writer: await p, port, sink, connector, deliver };
}
const claimed = (writer, text = '{"id":1}') => {
  let receipt;
  writer.send(text, (promise) => (receipt = promise));
  return receipt;
};
const outcome = (promise) =>
  Promise.race([
    promise.then(
      () => 'sent',
      () => 'refused'
    ),
    tick().then(() => 'pending'),
  ]);

test("receipt: a claimed frame travels with a connection-local token and resolves only on main's success acknowledgement", async () => {
  const { writer, port } = await opened();
  const receipt = claimed(writer);
  const note = port.sent.at(-1);
  assert.equal(note.t, 'send');
  assert.equal(note.text, '{"id":1}');
  assert.equal(typeof note.token, 'number');
  assert.equal(await outcome(receipt), 'pending', 'posting to main is not departure');
  port.onmessage({ data: { t: 'sent', token: note.token, ok: true } });
  assert.equal(await outcome(receipt), 'sent');
  writer.send('plain');
  assert.equal(port.sent.at(-1), 'plain', 'an unclaimed frame stays a plain text frame');
});

test('receipt: a failed write, an unknown token and a duplicate acknowledgement', async () => {
  const { writer, port } = await opened();
  const failed = claimed(writer);
  const first = port.sent.at(-1).token;
  port.onmessage({ data: { t: 'sent', token: first + 100, ok: true } });
  assert.equal(await outcome(failed), 'pending', 'a token nobody asked for settles nothing');
  port.onmessage({ data: { t: 'sent', token: first, ok: false } });
  assert.equal(await outcome(failed), 'refused', 'a write error never resolves success');
  port.onmessage({ data: { t: 'sent', token: first, ok: true } });
  assert.equal(await outcome(failed), 'refused', 'a second acknowledgement of the same token changes nothing');
  const next = claimed(writer);
  const token = port.sent.at(-1).token;
  port.onmessage({ data: { t: 'sent', token, ok: true } });
  port.onmessage({ data: { t: 'sent', token, ok: false } });
  assert.equal(await outcome(next), 'sent', 'the first answer stands');
  assert.equal(await outcome(claimed(writer)), 'pending', 'a missing acknowledgement is neither success nor failure');
});

test('receipt: a closed port or a closed writer never resolves a pending write as sent; a late acknowledgement is ignored', async () => {
  const closing = await opened();
  const byPort = claimed(closing.writer);
  const token = closing.port.sent.at(-1).token;
  closing.port.onmessage({ data: { t: 'closed', code: 1006, reason: '' } });
  assert.equal(await outcome(byPort), 'refused');
  closing.port.onmessage({ data: { t: 'sent', token, ok: true } });
  assert.equal(await outcome(byPort), 'refused');
  const own = await opened();
  const byClose = claimed(own.writer);
  const ownToken = own.port.sent.at(-1).token;
  own.writer.close(1000, 'bye');
  assert.equal(await outcome(byClose), 'refused');
  own.port.onmessage({ data: { t: 'sent', token: ownToken, ok: true } });
  assert.equal(await outcome(byClose), 'refused');
});

test("receipt: an old connection's acknowledgement cannot touch the new connection", async () => {
  const { connector, deliver, sink } = setup();
  const open = async (generation) => {
    const port = fakePort();
    const p = connector.open({ id: 'local' }, sink);
    await tick();
    deliver(port, { generation });
    return { writer: await p, port };
  };
  const old = await open(1);
  const oldReceipt = claimed(old.writer);
  const oldToken = old.port.sent.at(-1).token;
  const fresh = await open(2);
  const freshReceipt = claimed(fresh.writer);
  assert.equal(fresh.port.sent.at(-1).token, oldToken, 'tokens are only meaningful on their own port');
  old.port.onmessage({ data: { t: 'sent', token: oldToken, ok: true } });
  assert.equal(
    await outcome(freshReceipt),
    'pending',
    "the old port's answer does not resolve the new connection's write"
  );
  fresh.port.onmessage({ data: { t: 'sent', token: oldToken, ok: true } });
  assert.equal(await outcome(freshReceipt), 'sent');
  assert.equal(await outcome(oldReceipt), 'sent', "the old connection's own write still reads its own answer");
});

test("settled: main's answer releases the barrier, a closed port releases it too, and neither is progress", async () => {
  const { writer, port, sink } = await opened();
  let progress = 0;
  sink.progress = () => progress++;
  const barrier = writer.settled();
  const note = port.sent.at(-1);
  assert.equal(note.t, 'settle');
  assert.equal(await outcome(barrier), 'pending', 'a main that has not answered has not settled');
  port.onmessage({ data: { t: 'settled', token: note.token + 7 } });
  assert.equal(await outcome(barrier), 'pending');
  port.onmessage({ data: { t: 'settled', token: note.token } });
  assert.equal(await outcome(barrier), 'sent');
  const second = writer.settled();
  port.onmessage({ data: { t: 'closed', code: 1006, reason: '' } });
  assert.equal(await outcome(second), 'sent');
  assert.equal(progress, 0, 'receipts and barriers are never progress');
});

test("main's explicit answer that the core ends the same way each time leaves the open pending, so the client ladder does not ask again; a rejection is always a failure, whatever its text says", async () => {
  const { connector, bridge, sink } = setup();
  bridge.open = async (o) => {
    bridge.opened.push(o);
    return { launchFailed: { message: 'the core ended', exitCode: 2, stderrPath: null } };
  };
  let settled = false;
  connector.open({ id: 'core' }, sink).then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, 'pending: no rejection for the ladder to retry');
  assert.equal(bridge.opened.length, 1);
  bridge.open = async () => {
    throw new Error('stderr said mixdog-core-launch-failed: and core is not ready: booting');
  };
  await assert.rejects(connector.open({ id: 'core' }, sink), /not ready/);
});
test('a parked open resumes when main reports the failure gone, and asks main again', async () => {
  const { connector, bridge, deliver, sink } = setup();
  let listener;
  let first = true;
  bridge.onBootReport = (l) => {
    listener = l;
    return () => {};
  };
  const open = bridge.open;
  bridge.open = async (o) => {
    if (first) {
      first = false;
      bridge.opened.push(o);
      return { launchFailed: { message: 'ended', exitCode: 2, stderrPath: null } };
    }
    return open(o);
  };
  const port = fakePort();
  const opening = connector.open({ id: 'core' }, sink);
  await tick();
  listener({ progress: null, failure: { message: 'ended', exitCode: 2, stderrPath: null } });
  await tick();
  assert.equal(bridge.opened.length, 1, 'still parked while the failure stands');
  listener({ progress: null, failure: null });
  await tick();
  assert.equal(bridge.opened.length, 2, 'asked main again');
  deliver(port, { generation: 1 });
  const writer = await opening;
  assert.ok(writer);
});

test('a newer generation immediately rejects stale waiting promises for the same slot without waiting for timeout', async () => {
  const { connector, deliver, sink } = setup(10_000);
  const stalePrimary = connector.open({ id: 'local' }, sink);
  const freshPrimary = connector.open({ id: 'local' }, sink);
  const otherSlot = connector.open({ id: 'pc' }, sink);
  await tick();

  const primaryPort = fakePort();
  deliver(primaryPort, { generation: 2, slot: 'primary' });

  await assert.rejects(stalePrimary, /superseded by generation 2/);
  const primaryWriter = await freshPrimary;
  assert.ok(primaryWriter);

  const pcPort = fakePort();
  deliver(pcPort, { generation: 3, slot: 'pc' });
  const pcWriter = await otherSlot;
  assert.ok(pcWriter);
});

test('a stale bridge.open reply arriving after a newer port already landed rejects immediately without waiting for timeout', async () => {
  const { connector, bridge, deliver, sink } = setup(10_000);
  let resolveOld;
  const oldReply = new Promise((resolve) => {
    resolveOld = resolve;
  });
  let calls = 0;
  bridge.open = async () => {
    calls += 1;
    if (calls === 1) return oldReply;
    return { generation: 2 };
  };

  const staleOpen = connector.open({ id: 'local' }, sink);
  const freshOpen = connector.open({ id: 'local' }, sink);
  await tick();

  deliver(fakePort(), { generation: 2, slot: 'primary' });
  assert.ok(await freshOpen);

  resolveOld({ generation: 1 });
  await assert.rejects(staleOpen, /superseded by generation 2/);
});
