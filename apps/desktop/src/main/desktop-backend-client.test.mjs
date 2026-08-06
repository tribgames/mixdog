import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { createLatestStateMailbox } from './desktop-backend-protocol.ts';
import { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder } from './state-delta.ts';
import { DesktopBackendClient } from './desktop-backend-client.ts';
import { desktopModelBootstrapFromConfig } from './model-bootstrap.ts';

class FakeTransport extends EventEmitter {
  posted = [];
  closed = false;

  constructor(onPost) {
    super();
    this.onPost = onPost;
  }

  postMessage(message) {
    this.posted.push(message);
    this.onPost?.(message, this);
  }

  async close() {
    this.closed = true;
  }
}

const engineOptions = () => ({
  userDataPath: 'C:\\mixdog-test',
  packaged: false,
  resourcesPath: 'C:\\mixdog-test\\resources',
  appPath: 'C:\\mixdog-test\\app',
});

function readyTransport(requestHandler, initialSessions = null) {
  return new FakeTransport((message, transport) => {
    if (message.kind === 'init') {
      queueMicrotask(() => {
        if (Array.isArray(initialSessions)) {
          transport.emit('message', { kind: 'sessions', sessions: initialSessions });
        }
        transport.emit('message', {
          kind: 'state',
          sequence: 1,
          wire: { items: [], queued: [], __itemsRevision: 1 },
        });
        transport.emit('message', { kind: 'ready' });
      });
      return;
    }
    requestHandler?.(message, transport);
  });
}

test('backend snapshot delta reconstruction preserves unchanged transcript identity', () => {
  const encoder = createSnapshotDeltaEncoder();
  const decoder = createSnapshotDeltaDecoder();
  const firstItem = { id: 'one', kind: 'user', text: 'hello' };
  const epoch = Symbol.for('mixdog.streaming-tail-text-epoch');
  const firstTail = { id: 'tail', kind: 'assistant', text: 'a' };
  const firstSource = { items: [firstItem], streamingTail: firstTail, busy: true };
  Object.defineProperty(firstSource, epoch, { value: 7 });
  const first = decoder.decode(encoder.encode(firstSource));
  assert.equal(first.ok, true);
  assert.equal(first.snapshot[epoch], 7);
  const displayed = first.snapshot.items[0];
  const secondItem = { id: 'two', kind: 'assistant', text: 'world' };
  const secondSource = {
    items: [firstItem, secondItem],
    streamingTail: { id: 'tail', kind: 'assistant', text: 'ab' },
    busy: false,
  };
  Object.defineProperty(secondSource, epoch, { value: 7 });
  const secondWire = encoder.encode(secondSource);
  assert.equal(secondWire.streamingTail, undefined);
  assert.deepEqual(secondWire.__streamingTailPatch, {
    prefix: 1,
    append: 'b',
    tail: { id: 'tail', kind: 'assistant' },
  });
  assert.deepEqual(secondWire.__statePatch.changed, { busy: false });
  const second = decoder.decode(secondWire);
  assert.equal(second.ok, true);
  assert.equal(second.snapshot.items[0], displayed);
  assert.equal(second.snapshot.items[1], secondItem);
  assert.equal(second.snapshot.streamingTail.text, 'ab');
  assert.equal(second.snapshot.busy, false);
  assert.equal(second.snapshot[epoch], 7);

  const largeEncoder = createSnapshotDeltaEncoder();
  const largeText = 'x'.repeat(100_000);
  const largeFirst = { items: [], streamingTail: { id: 'large', text: largeText } };
  const largeSecond = { items: [], streamingTail: { id: 'large', text: `${largeText}!` } };
  Object.defineProperty(largeFirst, epoch, { value: 9 });
  Object.defineProperty(largeSecond, epoch, { value: 9 });
  largeEncoder.encode(largeFirst);
  const compactWire = largeEncoder.encode(largeSecond);
  assert.equal(compactWire.__streamingTailPatch.append, '!');
  assert.ok(JSON.stringify(compactWire).length < 1_000);

  const lost = decoder.decode({
    __itemsPatch: { base: 99, revision: 100, prefix: 0, append: [] },
  });
  assert.equal(lost.ok, false);
});

test('latest-state mailbox keeps one frame in flight and collapses intermediate snapshots', () => {
  const sent = [];
  const mailbox = createLatestStateMailbox((sequence, value) => {
    sent.push({ sequence, value });
  });
  mailbox.publish('first');
  mailbox.publish('second');
  mailbox.publish('latest');
  assert.deepEqual(sent, [{ sequence: 1, value: 'first' }]);
  mailbox.acknowledge(99);
  assert.equal(sent.length, 1);
  mailbox.acknowledge(1);
  assert.deepEqual(sent[1], { sequence: 2, value: 'latest' });
  mailbox.reset('resynced');
  assert.deepEqual(sent[2], { sequence: 3, value: 'resynced' });
  mailbox.acknowledge(2);
  assert.equal(sent.length, 3);
  mailbox.acknowledge(3);
  mailbox.publish('after');
  assert.deepEqual(sent[3], { sequence: 4, value: 'after' });
});

test('backend client serializes RPC responses and enforces bounded request timeouts', async () => {
  const transport = readyTransport((message, current) => {
    if (message.kind === 'request' && message.method === 'listProjects') {
      queueMicrotask(() => current.emit('message', {
        kind: 'response',
        id: message.id,
        ok: true,
        value: [{ id: 'project', path: 'C:\\project', name: 'Project' }],
      }));
    }
  });
  const host = new DesktopBackendClient({
    connect: () => transport,
    engineOptions,
    requestTimeoutMs: 15,
  });
  try {
    assert.equal((await host.listProjects())[0].path, 'C:\\project');
    await assert.rejects(() => host.startTask(), /request timed out: startTask/);
  } finally {
    await host.dispose();
  }
});

test('backend client closes its subscription without issuing a backend dispose RPC', async () => {
  const transport = readyTransport();
  const host = new DesktopBackendClient({ connect: () => transport, engineOptions });
  await host.start();
  await host.dispose();
  assert.equal(transport.closed, true);
  assert.equal(
    transport.posted.some((message) => message.kind === 'request' && message.method === 'dispose'),
    false,
  );
});

test('backend client serves transport-primed sessions before issuing a catalog RPC', async () => {
  let listRequests = 0;
  const initial = [{ id: 'cached', title: 'Cached session' }];
  const transport = readyTransport((message, current) => {
    if (message.kind === 'request' && message.method === 'listSessions') {
      listRequests += 1;
      queueMicrotask(() => current.emit('message', {
        kind: 'response',
        id: message.id,
        ok: true,
        value: [{ id: 'refreshed', title: 'Refreshed session' }],
      }));
    }
  }, initial);
  const host = new DesktopBackendClient({ connect: () => transport, engineOptions });
  try {
    assert.deepEqual((await host.listSessions()).map((session) => session.id), ['cached']);
    assert.equal(listRequests, 0);
    assert.deepEqual((await host.listSessions()).map((session) => session.id), ['refreshed']);
    assert.equal(listRequests, 1);
  } finally {
    await host.dispose();
  }
});

test('backend client forwards the process-global agent pool push and cached initial read', async () => {
  const transport = readyTransport();
  const host = new DesktopBackendClient({ connect: () => transport, engineOptions });
  const rows = [{
    tag: 'pool-agent',
    sessionId: 'agent_pool_child',
    ownerSessionId: 'agent_pool_owner',
    status: 'running',
    stage: 'streaming',
  }];
  const publications = [];
  const unsubscribe = host.subscribeAgentPool((agents) => publications.push(agents));
  try {
    await host.start();
    transport.emit('message', { kind: 'agent-pool', agents: rows });
    assert.equal(publications.at(-1)[0].sessionId, 'agent_pool_child');
    assert.deepEqual(await host.listAgentPool(), rows);
    assert.equal(
      transport.posted.some((message) => (
        message.kind === 'request' && message.method === 'listAgentPool'
      )),
      false,
      'the first renderer read should consume the transport-primed pool',
    );
  } finally {
    unsubscribe();
    await host.dispose();
  }
});

test('backend client forwards pane peek and publishes the replayed session lane', async () => {
  const encoder = createSnapshotDeltaEncoder();
  const transport = readyTransport((message, current) => {
    if (message.kind !== 'request' || message.method !== 'peekSession') return;
    queueMicrotask(() => {
      current.emit('message', {
        kind: 'session-state',
        sessionId: message.args[0],
        wire: encoder.encode({
          sessionId: message.args[0],
          items: [{ id: 'restored', kind: 'assistant', text: 'restored transcript' }],
          queued: [],
        }),
      });
      current.emit('message', {
        kind: 'response',
        id: message.id,
        ok: true,
        value: true,
      });
    });
  });
  const host = new DesktopBackendClient({ connect: () => transport, engineOptions });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  try {
    assert.equal(await host.peekSession('desktop_restored'), true);
    assert.deepEqual(
      transport.posted.find((message) => (
        message.kind === 'request' && message.method === 'peekSession'
      ))?.args,
      ['desktop_restored'],
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].sessionId, 'desktop_restored');
    assert.equal(updates[0].snapshot.items[0].text, 'restored transcript');
  } finally {
    unsubscribe();
    await host.dispose();
  }
});

test('backend client reconstructs pane deltas without replacing settled transcript items', async () => {
  const transport = readyTransport();
  const host = new DesktopBackendClient({ connect: () => transport, engineOptions });
  const updates = [];
  const unsubscribe = host.subscribeSessionStates((update) => updates.push(update));
  const encoder = createSnapshotDeltaEncoder();
  const firstItem = { id: 'settled', kind: 'user', text: 'keep identity' };
  try {
    await host.start();
    transport.emit('message', {
      kind: 'session-state',
      sessionId: 'desktop_delta',
      wire: encoder.encode({
        sessionId: 'desktop_delta',
        items: [firstItem],
        streamingTail: { id: 'tail', kind: 'assistant', text: 'a' },
        busy: true,
      }),
    });
    const displayed = updates[0].snapshot.items[0];
    transport.emit('message', {
      kind: 'session-state',
      sessionId: 'desktop_delta',
      wire: encoder.encode({
        sessionId: 'desktop_delta',
        items: [firstItem],
        streamingTail: { id: 'tail', kind: 'assistant', text: 'ab' },
        busy: true,
      }),
    });
    assert.equal(updates[1].snapshot.items[0], displayed);
    assert.equal(updates[1].snapshot.streamingTail.text, 'ab');

    transport.emit('message', {
      kind: 'session-state',
      sessionId: 'desktop_delta',
      wire: { __itemsPatch: { base: 999, revision: 1000, prefix: 0, append: [] } },
    });
    assert.equal(
      transport.posted.some((message) => (
        message.kind === 'session-state-resync' && message.sessionId === 'desktop_delta'
      )),
      true,
    );
  } finally {
    unsubscribe();
    await host.dispose();
  }
});

test('persisted default model survives the transport route-less startup frame', async () => {
  const initialSnapshot = desktopModelBootstrapFromConfig({
    agent: {
      default: 'main',
      presets: [{
        id: 'main',
        provider: 'openai-oauth',
        model: 'gpt-5.4',
        effort: 'medium',
      }],
      modelSettings: {
        'openai-oauth/gpt-5.4': { effort: 'high', fast: true },
      },
    },
  });
  assert.deepEqual(initialSnapshot, {
    items: [],
    queued: [],
    busy: false,
    commandBusy: false,
    provider: 'openai-oauth',
    model: 'gpt-5.4',
    effort: 'high',
    fast: true,
  });
  const transport = readyTransport();
  const host = new DesktopBackendClient({ connect: () => transport, engineOptions, initialSnapshot });
  try {
    await host.start();
    assert.equal(host.getSnapshot().provider, 'openai-oauth');
    assert.equal(host.getSnapshot().model, 'gpt-5.4');
  } finally {
    await host.dispose();
  }
});

test('backend client rejects a lost mutation and keeps bounded reconnect recovery available', async () => {
  const transports = [readyTransport(), readyTransport(), readyTransport()];
  let connected = 0;
  const snapshots = [];
  const host = new DesktopBackendClient({
    connect: () => transports[connected++],
    engineOptions,
    requestTimeoutMs: 100,
    restartBaseDelayMs: 0,
    restartMaxDelayMs: 0,
    failureNoticeDelayMs: 0,
  });
  const unsubscribe = host.subscribe((snapshot) => snapshots.push(snapshot));
  try {
    await host.start();
    assert.equal(
      transports[0].posted.some((message) => message.kind === 'state-ack' && message.sequence === 1),
      true,
    );
    const pending = host.submitToSession('explicit-session', 'do not replay', { id: 'one-shot' });
    transports[0].emit('exit', 9);
    assert.match(snapshots.at(-1).toasts.at(-1).text, /backend connection stopped/i);
    await assert.rejects(() => pending, /exited with code 9/);
    await host.start();
    assert.equal(connected, 2);
    assert.equal(
      transports[1].posted.some((message) => (
        message.kind === 'request' && message.method === 'submitToSession'
      )),
      false,
    );
    assert.notEqual(snapshots.at(-1).busy, true);
    assert.equal(
      Boolean(snapshots.at(-1).toasts?.some(
        (toast) => toast?.id === 'backend-connection-stopped',
      )),
      false,
      'successful recovery removes the process-local warning',
    );

    transports[1].emit('exit', 10);
    await host.start();
    assert.equal(connected, 3, 'a later disconnect remains recoverable');
  } finally {
    unsubscribe();
    await host.dispose();
  }
});

test('a brief daemon reconnect stays silent by default', async () => {
  const transports = [readyTransport(), readyTransport()];
  let connected = 0;
  const snapshots = [];
  const host = new DesktopBackendClient({
    connect: () => transports[connected++],
    engineOptions,
    restartBaseDelayMs: 0,
    restartMaxDelayMs: 0,
  });
  const unsubscribe = host.subscribe((snapshot) => snapshots.push(snapshot));
  try {
    await host.start();
    transports[0].emit('exit', 1);
    assert.equal(
      Boolean(snapshots.at(-1).toasts?.some(
        (toast) => toast?.id === 'backend-connection-stopped',
      )),
      false,
      'a recoverable transport handoff does not flash an error',
    );
    await host.start();
    assert.equal(connected, 2);
    assert.equal(
      Boolean(snapshots.at(-1).toasts?.some(
        (toast) => toast?.id === 'backend-connection-stopped',
      )),
      false,
    );
  } finally {
    unsubscribe();
    await host.dispose();
  }
});

test('backend client forwards in-place stream recovery diagnostics without changing state', async () => {
  const transport = readyTransport();
  const diagnostics = [];
  const host = new DesktopBackendClient({
    connect: () => transport,
    engineOptions,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });
  try {
    await host.start();
    const before = host.getSnapshot();
    transport.emit('diagnostic', 'backend-stream-reconnected', {
      reason: 'sse ended',
      attempt: 1,
      downtimeMs: 20,
    });
    assert.equal(host.getSnapshot(), before);
    assert.deepEqual(diagnostics, [{
      event: 'backend-stream-reconnected',
      details: { reason: 'sse ended', attempt: 1, downtimeMs: 20 },
    }]);
  } finally {
    await host.dispose();
  }
});

test('backend client retries a read RPC once after transport recovery', async () => {
  const transports = [
    readyTransport((message, transport) => {
      if (message.kind === 'request' && message.method === 'statProjectFile') {
        queueMicrotask(() => transport.emit('exit', 0xc0000409));
      }
    }),
    readyTransport((message, transport) => {
      if (message.kind === 'request' && message.method === 'statProjectFile') {
        queueMicrotask(() => transport.emit('message', {
          kind: 'response',
          id: message.id,
          ok: true,
          value: { mtimeMs: 42, size: 7 },
        }));
      }
    }),
  ];
  let connected = 0;
  const host = new DesktopBackendClient({
    connect: () => transports[connected++],
    engineOptions,
    restartBaseDelayMs: 0,
    restartMaxDelayMs: 0,
  });
  try {
    assert.deepEqual(
      await host.statProjectFile('C:\\project', 'package.json'),
      { mtimeMs: 42, size: 7 },
    );
    assert.equal(connected, 2);
  } finally {
    await host.dispose();
  }
});
