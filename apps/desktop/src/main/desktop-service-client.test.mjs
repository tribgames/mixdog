import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DesktopServiceClient } from './desktop-service-client.ts';
import { DESKTOP_SERVICE_METHODS } from './desktop-service-contract.ts';
import { readSessionAttachment } from './session-attachments.ts';
import { RemoteBootstrapError } from './ssh/remote-bootstrap.ts';

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

test('an aborted final-answer read rejects with the abort reason and drops the late reply', async () => {
  const transport = new ControlledTransport();
  const client = new DesktopServiceClient({
    connect: () => transport,
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
    startupTimeoutMs: 1_000,
  });
  try {
    const controller = new AbortController();
    const read = client.readSessionFinalAnswer('session_a', 1_000, controller.signal);
    while (!transport.requests.length) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(transport.requests[0].args, ['session_a', 1_000]);
    const reason = new Error('read deadline');
    controller.abort(reason);
    await assert.rejects(read, (error) => error === reason);
    assert.equal(client.pending.size, 0);
    transport.respond(transport.requests[0], null);
    await assert.rejects(
      client.readSessionFinalAnswer('session_a', 1_000, controller.signal),
      (error) => error === reason
    );
    assert.equal(transport.requests.length, 1, 'an already-aborted read is never sent');
  } finally {
    await client.dispose();
  }
});

test('a window opens a sent attachment: the client reads the transcript the service holds', async () => {
  const bytes = Buffer.from('png bytes');
  const id = createHash('sha256').update(bytes).digest('hex');
  const transport = new ControlledTransport();
  const client = new DesktopServiceClient({
    connect: () => transport,
    sessionOptions: () => ({ userDataPath: 'C:/tmp/mixdog', packaged: false }),
    startupTimeoutMs: 1_000,
  });
  const answers = {
    readSessionTranscript: {
      items: [{ id: 'u1', kind: 'user', text: '', images: [{ id: 1, name: 'shot.png', attachmentRef: id }] }],
    },
    readAttachmentImage: bytes.toString('base64'),
  };
  const served = (async () => {
    for (let answered = 0; answered < 2; ) {
      const request = transport.requests[answered];
      if (!request) {
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      transport.respond(request, answers[request.method]);
      answered += 1;
    }
  })();
  try {
    assert.ok(DESKTOP_SERVICE_METHODS.includes('readSessionTranscript'));
    assert.ok(DESKTOP_SERVICE_METHODS.includes('readSessionHistory'));
    const { meta, bytes: read } = await readSessionAttachment(client, 'session_a', id);
    await served;
    assert.equal(meta.name, 'shot.png');
    assert.deepEqual(read, bytes);
    assert.deepEqual(transport.requests[0].args, ['session_a']);
  } finally {
    await client.dispose();
  }
});

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
    await assert.rejects(client.start(), /daemon session endpoint is unavailable/);
    assert.ok(connections > 1, 'startup should retry before reaching its deadline');
  } finally {
    clearTimeout(keepAlive);
    await client.dispose();
  }
});

test('a terminal remote failure stops reconnecting and shows its reason at once', async () => {
  let connections = 0;
  const refusal = new RemoteBootstrapError(
    'daemon-not-proxy',
    'A Mixdog daemon (pid 1667) is already running on the server without desktop model proxy mode.'
  );
  const client = new DesktopServiceClient({
    connect() {
      connections += 1;
      return new TestTransport((transport) => {
        transport.emit('exit', 1, refusal);
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
    startupTimeoutMs: 1_000,
    failureNoticeDelayMs: 1_000,
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    // The refusal itself (not the startup timeout error) is what start() rejects with.
    await assert.rejects(client.start(), (error) => error === refusal);
    await turn();
    assert.equal(connections, 1);
    await assert.rejects(client.start(), (error) => error === refusal);
    assert.equal(connections, 1);
    const toasts = client.getSnapshot().toasts;
    assert.equal(toasts.at(-1).text, refusal.message);
  } finally {
    clearTimeout(keepAlive);
    await client.dispose();
  }
});

test('an upgrade wait suspends the startup timeout without a failure toast', async (t) => {
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
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const started = client.start().then(
      () => (settled = 'ready'),
      () => (settled = 'rejected')
    );
    transport.emit('message', { kind: 'upgrade-wait', state: 'waiting', fromVersion: '1.0.0', toVersion: '1.1.0' });
    t.mock.timers.tick(120);
    await turn();
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

test('a timed-out desktop operation names the operation, not just the transport method', async () => {
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
    await assert.rejects(
      client.invokeDesktopOperation('gitReview', ['C:/tmp/project', 'uncommitted']),
      /timed out: invokeDesktopOperation \(gitReview\)\./
    );
  } finally {
    await client.dispose();
  }
});

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('Local Provider asset installs outlive the ordinary desktop request deadline', async (t) => {
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
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ordinary = assert.rejects(client.addProject('C:/tmp/project'), /request timed out/);
    await turn();
    t.mock.timers.tick(20);
    await ordinary;

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
      await turn();
      t.mock.timers.tick(40);
      await turn();
      assert.equal(settled, false, `${capability} must not inherit the 20ms ordinary deadline`);
      const request = transport.requests.at(-1);
      transport.respond(request, { value: { ok: true }, snapshot: null });
      assert.deepEqual((await pending).value, { ok: true });
    }
  } finally {
    await client.dispose();
  }
});

test('built-in dependency installs outlive the ordinary desktop request deadline', async (t) => {
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
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Turning Voice off never downloads, so it keeps the ordinary deadline.
    const ordinary = assert.rejects(client.invokeCapability('toggleVoice', [false]), /request timed out/);
    await turn();
    t.mock.timers.tick(20);
    await ordinary;

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
      await turn();
      t.mock.timers.tick(40);
      await turn();
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

test('a short outage reconnects silently; only a lasting one shows the localizable notice', async (t) => {
  let live = 0;
  const transports = [];
  const client = new DesktopServiceClient({
    connect() {
      live += 1;
      const transport = new TestTransport(
        live === 1 ? (current) => current.emit('message', { kind: 'ready' }) : () => {}
      );
      transports.push(transport);
      return transport;
    },
    sessionOptions: () => ({ userDataPath: 'C:/tmp/mixdog', packaged: true, resourcesPath: 'C:/tmp/resources' }),
    restartBaseDelayMs: 1,
    restartMaxDelayMs: 1,
    startupTimeoutMs: 120_000,
  });
  const working = { sessionId: 's', items: [], busy: true, queued: [{ id: 'q1' }], toasts: [] };
  try {
    await client.start();
    client.cachedSnapshot = working;
    const seen = [];
    client.subscribe((snapshot) => seen.push(snapshot));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    transports[0].emit('exit', 1);
    t.mock.timers.tick(59_000);
    assert.equal(seen.length, 0, 'a stall shorter than a minute publishes nothing');
    assert.equal(client.getSnapshot().busy, true, 'busy survives the silent outage');
    assert.equal(client.getSnapshot().queued.length, 1, 'queued survives the silent outage');
    t.mock.timers.tick(1_000);
    const lasting = seen.at(-1);
    assert.equal(lasting.busy, false);
    assert.deepEqual(lasting.queued, []);
    assert.equal(
      lasting.toasts.at(-1).text,
      'The service connection has been lost for a while. Still retrying automatically.'
    );
  } finally {
    t.mock.timers.reset();
    await client.dispose();
  }
});

test('a decision in flight when the service transport restarts is sent again, not lost as an error', async () => {
  const transports = [];
  const client = new DesktopServiceClient({
    connect() {
      const transport = new ControlledTransport();
      transports.push(transport);
      return transport;
    },
    sessionOptions: () => ({ userDataPath: 'C:/tmp/mixdog', packaged: true, resourcesPath: 'C:/tmp/resources' }),
    restartBaseDelayMs: 1,
    restartMaxDelayMs: 1,
    startupTimeoutMs: 1_000,
    failureNoticeDelayMs: 60_000,
  });
  const waitFor = async (ready) => {
    while (!ready()) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const decision = { approved: true, answers: [{ question: 'q', answer: 'a' }] };
    const answer = client.resolveToolApprovalForSession('session_a', 'approval_1', decision);
    await waitFor(() => transports[0]?.requests.length === 1);
    // The daemon stalled: the service process gave up on its own call and exited.
    transports[0].emit('exit', 1, new Error('session timeout: POST /client/register'));
    await waitFor(() => transports[1]?.requests.length === 1);
    assert.equal(transports[1].requests[0].method, 'resolveToolApprovalForSession');
    assert.deepEqual(transports[1].requests[0].args, ['session_a', 'approval_1', decision]);
    transports[1].respond(transports[1].requests[0], true);
    assert.equal(await answer, true, 'the answer the user gave is recorded once the service is back');
  } finally {
    await client.dispose();
  }
});

test('displayExitCode names OOM exits and keeps the number', async () => {
  const { displayExitCode } = await import('./desktop-service-client.ts');
  assert.equal(displayExitCode(134), '134 (V8 fatal error (JavaScript heap out of memory))');
  assert.equal(displayExitCode(0xe0000008), '0xE0000008 (out of memory)');
  assert.equal(displayExitCode(-536870904), '-536870904 (out of memory)');
});
