import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DesktopServiceClient } from './desktop-service-client.ts';

class TestTransport extends EventEmitter {
  constructor(onInit) {
    super();
    this.onInit = onInit;
    this.requests = [];
  }

  postMessage(message) {
    if (message.kind === 'init') {
      queueMicrotask(() => this.onInit(this));
      return;
    }
    if (message.kind !== 'request') return;
    this.requests.push(message);
    queueMicrotask(() => this.emit('message', {
      kind: 'response',
      id: message.id,
      ok: true,
      value: {
        accepted: true,
        sessionId: 'session_ready',
        snapshot: { sessionId: 'session_ready', items: [], queued: [] },
      },
    }));
  }

  async close() {}
}

test('an immediate mutation stays queued across a pre-ready daemon handoff', async () => {
  const transports = [];
  const client = new DesktopServiceClient({
    connect() {
      const index = transports.length;
      const transport = new TestTransport((current) => {
        if (index === 0) {
          current.emit('exit', 1, new Error('daemon session endpoint is unavailable'));
        } else {
          current.emit('message', { kind: 'ready' });
        }
      });
      transports.push(transport);
      return transport;
    },
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
    restartBaseDelayMs: 1,
    restartMaxDelayMs: 1,
    startupTimeoutMs: 1_000,
    failureNoticeDelayMs: 1_000,
  });
  try {
    const result = await client.submitNewTask(
      'boot-safe prompt',
      { id: 'desktop-submit-boot-safe' },
      {},
    );
    assert.equal(result.accepted, true);
    assert.equal(transports.length, 2);
    assert.equal(transports[0].requests.length, 0);
    assert.equal(transports[1].requests.length, 1);
    assert.equal(transports[1].requests[0].method, 'submitNewTask');
  } finally {
    await client.dispose();
  }
});

test('pre-ready daemon handoff retries remain bounded by the startup timeout', async () => {
  let connections = 0;
  const client = new DesktopServiceClient({
    connect() {
      connections += 1;
      return new TestTransport((transport) => {
        transport.emit('exit', 1, new Error('daemon session endpoint is unavailable'));
      });
    },
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
    restartBaseDelayMs: 1,
    restartMaxDelayMs: 1,
    startupTimeoutMs: 30,
    failureNoticeDelayMs: 1_000,
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      client.start(),
      /daemon session endpoint is unavailable/,
    );
    assert.ok(connections > 1, 'startup should retry before reaching its deadline');
    assert.ok(Date.now() - startedAt < 500, 'startup timeout must stay bounded');
  } finally {
    clearTimeout(keepAlive);
    await client.dispose();
  }
});
