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
    queueMicrotask(() =>
      this.emit('message', {
        kind: 'response',
        id: message.id,
        ok: true,
        value: {
          accepted: true,
          sessionId: 'session_ready',
          snapshot: { sessionId: 'session_ready', items: [], queued: [] },
        },
      })
    );
  }

  async close() {}
}

class ControlledTransport extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
  }

  postMessage(message) {
    if (message.kind === 'init') {
      queueMicrotask(() => this.emit('message', { kind: 'ready' }));
      return;
    }
    if (message.kind === 'request') this.requests.push(message);
  }

  respond(request, value) {
    this.emit('message', {
      kind: 'response',
      id: request.id,
      ok: true,
      value,
    });
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
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    const result = await client.submitNewTask('boot-safe prompt', { id: 'desktop-submit-boot-safe' }, {});
    assert.equal(result.accepted, true);
    assert.equal(transports.length, 2);
    assert.equal(transports[0].requests.length, 0);
    assert.equal(transports[1].requests.length, 1);
    assert.equal(transports[1].requests[0].method, 'submitNewTask');
  } finally {
    clearTimeout(keepAlive);
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
    await assert.rejects(client.start(), /daemon session endpoint is unavailable/);
    assert.ok(connections > 1, 'startup should retry before reaching its deadline');
    assert.ok(Date.now() - startedAt < 500, 'startup timeout must stay bounded');
  } finally {
    clearTimeout(keepAlive);
    await client.dispose();
  }
});

test('an upgrade wait suspends the startup timeout without a failure toast', async () => {
  let transport;
  const client = new DesktopServiceClient({
    connect() {
      transport = new TestTransport(() => {});
      return transport;
    },
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
    startupTimeoutMs: 30,
    failureNoticeDelayMs: 0,
  });
  const snapshots = [];
  client.subscribe((snapshot) => snapshots.push(snapshot));
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    let settled = false;
    const started = client.start().then(
      () => (settled = 'ready'),
      () => (settled = 'rejected')
    );
    transport.emit('message', { kind: 'upgrade-wait', state: 'waiting', fromVersion: '1.0.0', toVersion: '1.1.0' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(settled, false, 'startup must keep waiting past startupTimeoutMs');
    for (const snapshot of snapshots) {
      assert.ok(!JSON.stringify(snapshot).includes('service-connection-stopped'));
    }
    transport.emit('message', { kind: 'ready' });
    await started;
    assert.equal(settled, 'ready');
  } finally {
    clearTimeout(keepAlive);
    await client.dispose();
  }
});

test('startup timing resumes after the upgrade wait is done', async () => {
  let transport;
  const client = new DesktopServiceClient({
    connect() {
      transport = new TestTransport(() => {});
      return transport;
    },
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
    startupTimeoutMs: 30,
    failureNoticeDelayMs: 1_000,
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const started = client.start();
    transport.emit('message', { kind: 'upgrade-wait', state: 'waiting' });
    transport.emit('message', { kind: 'upgrade-wait', state: 'done' });
    await assert.rejects(started, /startup timed out/);
  } finally {
    clearTimeout(keepAlive);
    await client.dispose();
  }
});

test('a daemon replaced behind a live transport counts as a new attachment', async () => {
  const readyGenerations = [];
  let live = null;
  const client = new DesktopServiceClient({
    connect() {
      const transport = new TestTransport((current) => {
        live = current;
        current.emit('message', { kind: 'ready' });
      });
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
    onServiceReady: ({ generation }) => {
      readyGenerations.push(generation);
    },
  });
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    await client.start();
    await client.setVisibleSessions(['session_ready']);
    assert.deepEqual(readyGenerations, [1]);
    live.requests.length = 0;

    live.emit('message', { kind: 'daemon-replaced' });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // A raised generation is what the host redials the relay off; the
    // renderer's registration has to reach the new process as well.
    assert.deepEqual(readyGenerations, [1, 2]);
    assert.deepEqual(
      live.requests.map((request) => request.method),
      ['setVisibleSessions']
    );
  } finally {
    clearTimeout(keepAlive);
    await client.dispose();
  }
});

test('overlapping desktop registrations carry increasing versions before either reply arrives', async () => {
  const transport = new ControlledTransport();
  const client = new DesktopServiceClient({
    connect: () => transport,
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
  });
  try {
    await client.start();
    const old = client.setVisibleSessions(['old']);
    const current = client.setVisibleSessions(['current']);
    await Promise.resolve();
    await Promise.resolve();
    const [a, b] = transport.requests;
    assert.deepEqual(a.args[0], ['old']);
    assert.deepEqual(b.args[0], ['current']);
    assert.ok(b.args[1] > a.args[1]);
    transport.respond(b, true);
    assert.equal(await current, true);
    transport.respond(a, true);
    assert.equal(await old, true);
  } finally {
    await client.dispose();
  }
});

test('Local Provider asset installs outlive the ordinary desktop request deadline', async () => {
  const transport = new ControlledTransport();
  const client = new DesktopServiceClient({
    connect: () => transport,
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
    requestTimeoutMs: 20,
    startupTimeoutMs: 1_000,
    failureNoticeDelayMs: 1_000,
  });
  try {
    await client.start();
    await assert.rejects(client.addProject('C:/tmp/project'), /request timed out/);

    for (const [capability, args] of [
      ['installBuiltinFeature', ['localProvider']],
      ['installLocalProviderModel', ['qwen3.8-27b-q4-k-m']],
    ]) {
      const pending = client.invokeCapability(capability, args);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(settled, false, `${capability} must not inherit the 20ms ordinary deadline`);
      const request = transport.requests.at(-1);
      transport.respond(request, { value: { ok: true }, snapshot: null });
      assert.deepEqual((await pending).value, { ok: true });
    }
  } finally {
    await client.dispose();
  }
});

test('built-in dependency installs outlive the ordinary desktop request deadline', async () => {
  const transport = new ControlledTransport();
  const client = new DesktopServiceClient({
    connect: () => transport,
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
    requestTimeoutMs: 20,
    startupTimeoutMs: 1_000,
    failureNoticeDelayMs: 1_000,
  });
  try {
    await client.start();
    // Turning Voice off never downloads, so it keeps the ordinary deadline.
    await assert.rejects(client.invokeCapability('toggleVoice', [false]), /request timed out/);

    for (const [label, call] of [
      ['installLibreOffice', () => client.invokeDesktopOperation('installLibreOffice', [])],
      ['installGitCli', () => client.invokeDesktopOperation('installGitCli', [])],
      ['toggleVoice on', () => client.invokeCapability('toggleVoice', [true])],
      ['memory install', () => client.invokeCapability('installBuiltinFeature', ['memory'])],
      ['office install', () => client.invokeCapability('installBuiltinFeature', ['office'])],
    ]) {
      const pending = call();
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(settled, false, `${label} must not inherit the 20ms ordinary deadline`);
      transport.respond(transport.requests.at(-1), { installed: true });
      assert.deepEqual(await pending, { installed: true });
    }
  } finally {
    await client.dispose();
  }
});

test('an omitted trailing argument never reaches the JSON daemon lane as null', async () => {
  const transport = new ControlledTransport();
  const client = new DesktopServiceClient({
    connect: () => transport,
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
  });
  try {
    await client.start();
    // An editor save without an encoding change: JSON.stringify turned the
    // trailing `undefined` into `null`, which the file writer rejected
    // ("File encoding is invalid.") — every Ctrl+S failed.
    const save = client.writeProjectTextFile('C:/tmp/project', 'src/a.ts', 'next', 'prev', undefined);
    const granted = client.invokeDesktopOperation('writeProjectTextFileIn', [
      'C:/tmp/project',
      'src/a.ts',
      'next',
      'prev',
      undefined,
    ]);
    await Promise.resolve();
    await Promise.resolve();
    const [write, operation] = transport.requests;
    assert.deepEqual(JSON.parse(JSON.stringify(write.args)), ['C:/tmp/project', 'src/a.ts', 'next', 'prev']);
    assert.deepEqual(JSON.parse(JSON.stringify(operation.args)), [
      'writeProjectTextFileIn',
      ['C:/tmp/project', 'src/a.ts', 'next', 'prev'],
    ]);
    transport.respond(write, { mtimeMs: 1 });
    transport.respond(operation, { mtimeMs: 2 });
    assert.deepEqual(await Promise.all([save, granted]), [{ mtimeMs: 1 }, { mtimeMs: 2 }]);
  } finally {
    await client.dispose();
  }
});
