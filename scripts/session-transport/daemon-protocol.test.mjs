import test from 'node:test';
import assert from 'node:assert/strict';
import {
  performance,
  createSessionTransport,
  createSessionService,
  createChannelTransport,
  attachSession,
  probeSessionHealth,
  daemonShouldDetach,
  sessionDaemonCompatibility,
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
  daemonPost,
  waitForValue,
  createStubSessionRuntime,
  withDaemon,
  waitFor,
} from './_shared.mjs';


test('protocol stays at 1 while revision then app build chooses the daemon', () => {
  assert.equal(SESSION_PROTOCOL, 1);
  assert.equal(SESSION_REVISION, 5);
  assert.match(SESSION_CAPABILITY_FINGERPRINT, /^[0-9a-f]{16}$/);
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 1,
    version: '1.2.3',
    capabilityFingerprint: '0000000000000000',
  }, { revision: 1, version: '1.2.3' }).status, 'compatible');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 1,
    version: '1.2.2',
  }, { revision: 1, version: '1.2.3' }).status, 'client-newer');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 1,
    version: '1.2.4',
  }, { revision: 1, version: '1.2.3' }).status, 'daemon-newer');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 2,
    version: '1.0.0',
  }, { revision: 1, version: '9.0.0' }).status, 'daemon-newer');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 0,
    version: '9.0.0',
  }, { revision: 1, version: '1.0.0' }).status, 'client-newer');
  assert.equal(sessionDaemonCompatibility({
    protocol: 2,
    revision: 99,
    version: '1.0.0',
  }, { revision: 1, version: '9.0.0' }).status, 'protocol-mismatch');
  assert.equal(sessionDaemonCompatibility({
    protocol: 1,
    revision: 1,
    version: '1.2.3',
    capabilityFingerprint: '0000000000000000',
  }, { revision: 1, version: '1.2.3' }).capabilityMismatch, true);
});

test('Windows Desktop daemon stays in one Mixdog process tree while CLI daemons detach', () => {
  assert.equal(daemonShouldDetach({ platform: 'win32', processType: 'browser' }), false);
  assert.equal(daemonShouldDetach({ platform: 'win32', processType: undefined }), true);
  assert.equal(daemonShouldDetach({ platform: 'linux', processType: 'browser' }), true);
});

test('health and registration expose the current protocol', async () => {
  await withDaemon(async ({ discovery }) => {
    const health = await probeSessionHealth(discovery);
    assert.equal(health?.protocol, SESSION_PROTOCOL);
    assert.equal(health?.revision, SESSION_REVISION);
    assert.equal(health?.capabilityFingerprint, SESSION_CAPABILITY_FINGERPRINT);
    await assert.rejects(
      daemonPost(discovery, '/client/register', {
        leadPid: process.pid,
        cwd: process.cwd(),
        lifecycle: false,
      }),
      /session protocol 1 required/,
    );
    const client = await attachSession({ discovery, cwd: process.cwd() });
    try {
      assert.equal(client.protocol, SESSION_PROTOCOL);
      assert.equal(client.revision, SESSION_REVISION);
    } finally {
      await client.close('protocol contract verified');
    }
  });
});

test('desktop registration identity reaches the daemon lifecycle callback', async () => {
  let registered = null;
  const transport = createSessionTransport({
    handleCall: async () => ({ ok: true }),
    onClientRegistered: (client) => { registered = client; },
  });
  const discovery = await transport.start();
  let client = null;
  try {
    client = await attachSession({
      discovery: { ...discovery, pid: process.pid },
      cwd: process.cwd(),
      clientKind: 'desktop',
      lifecycle: false,
    });
    await waitFor(() => registered);
    assert.equal(registered.clientKind, 'desktop');
  } finally {
    await client?.close('desktop identity verified');
    await transport.stop();
  }
});

test('revision 0 clients keep read compatibility without retired channel mutations', async () => {
  const calls = [];
  const service = createSessionService({
    createSessionRuntime: async () => Object.assign(createStubSessionRuntime(), {
      listProviderModels() {
        calls.push(['listProviderModels']);
        return ['model-a'];
      },
    }),
  });
  try {
    const ctx = { clientToken: 'revision_zero', revision: 0 };
    const created = await service.handleCall('session.create', {
      sessionId: 'revision_zero_session',
    }, ctx);
    const models = await service.handleCall('session.configure', {
      sessionId: created.sessionId,
      action: 'listProviderModels',
    }, ctx);
    assert.deepEqual(models.value, ['model-a']);
    assert.deepEqual(calls, [['listProviderModels']]);
    await assert.rejects(
      service.handleCall('session.configure', {
        sessionId: created.sessionId,
        action: 'setBackend',
        args: ['discord'],
      }, ctx),
      /session action setBackend is unavailable/,
    );
  } finally {
    await service.stop('test end');
  }
});

test('a higher app build keeps compatible clients live until handoff commits', async () => {
  let transport;
  let upgrade = null;
  const calls = [];
  transport = createSessionTransport({
    handleCall: async (name, args) => {
      calls.push({ name, args });
      return { name, args };
    },
    clientGraceMs: 5,
    onClientsEmpty: () => {},
    onUpgradeRequested(details) {
      upgrade = details;
      transport.beginDrain(`test replacement by ${details.version}`);
    },
  });
  const discovery = await transport.start();
  try {
    const registered = await daemonPost(discovery, '/client/register', {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      leadPid: process.pid,
      lifecycle: false,
    });
    assert.ok(registered.token);
    const accepted = await daemonPost(discovery, '/upgrade', {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      version: '9999.0.0',
    });
    assert.equal(accepted.accepted, true);
    await waitForValue(() => upgrade);
    assert.equal(upgrade.protocol, SESSION_PROTOCOL);
    assert.equal(upgrade.version, '9999.0.0');
    const duringDrain = await daemonPost(discovery, '/call', {
      token: registered.token,
      name: 'test.compatible-call',
      args: { value: 1 },
      callId: 'compatible-call-during-drain',
    });
    assert.deepEqual(duringDrain.result, {
      name: 'test.compatible-call',
      args: { value: 1 },
    });
    const compatibleNewcomer = await daemonPost(discovery, '/client/register', {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      leadPid: process.pid,
      lifecycle: false,
    });
    assert.ok(compatibleNewcomer.token);
    const softHealth = await probeSessionHealth(discovery);
    assert.match(softHealth.draining, /test replacement/);
    assert.equal(softHealth.drainCommitted, false);
    assert.equal(transport.connectionCount, 2);
    assert.equal(transport.commitDrain('test replacement commit'), true);
    const committedHealth = await probeSessionHealth(discovery);
    assert.equal(committedHealth.drainCommitted, true);
    await assert.rejects(
      daemonPost(discovery, '/client/register', {
        protocol: SESSION_PROTOCOL,
        revision: SESSION_REVISION,
        leadPid: process.pid,
      }),
      /daemon is draining/,
    );
    await assert.rejects(
      daemonPost(discovery, '/call', {
        token: registered.token,
        name: 'test.must-not-run',
        args: {},
        callId: 'rejected-after-drain-commit',
      }),
      /daemon is draining/,
    );
    assert.equal(calls.length, 1);
  } finally {
    await transport.stop();
  }
});

test('a higher API revision drains the lower-revision daemon at the same app version', async () => {
  let transport;
  let upgrade = null;
  transport = createSessionTransport({
    handleCall: async () => null,
    clientGraceMs: 5,
    onClientsEmpty: () => {},
    onUpgradeRequested(details) {
      upgrade = details;
      transport.beginDrain('test equal-version replacement');
    },
  });
  const discovery = await transport.start();
  try {
    const accepted = await daemonPost(discovery, '/upgrade', {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION + 1,
      version: runtimeVersion(),
    });
    assert.equal(accepted.accepted, true);
    await waitForValue(() => upgrade);
    assert.equal(upgrade.revision, SESSION_REVISION + 1);
  } finally {
    await transport.stop();
  }
});

test('the first runtime client can start runtime prewarm before creating a session', async () => {
  const registrations = [];
  await withDaemon(async ({ discovery, service }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    try {
      assert.equal(service.size, 0);
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].lifecycle, true);
      assert.equal(registrations[0].cwd, process.cwd());
    } finally {
      await client.close('registration prewarm test');
    }
  }, {
    onClientRegistered: (row) => registrations.push(row),
  });
});

test('a lost registration response replays one client token instead of leaking lifecycle refs', async () => {
  await withDaemon(async ({ discovery, transport }) => {
    const body = {
      protocol: SESSION_PROTOCOL,
      leadPid: process.pid,
      cwd: process.cwd(),
      lifecycle: true,
      registrationId: 'stable-registration-replay',
    };
    const first = await daemonPost(discovery, '/client/register', body);
    const replay = await daemonPost(discovery, '/client/register', body);
    assert.equal(replay.token, first.token);
    assert.equal(transport.connectionCount, 1);
    await daemonPost(discovery, '/client/deregister', { token: first.token });
  });
});

test('health and registration bypass a burst of synchronous session call starts', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const work = Promise.all(Array.from({ length: 64 }, (_, index) =>
      client.call('session.read', {
        sessionId,
        action: 'getTheme',
        args: [index],
      }, { callId: `control-plane-work:${index}` })));
    await new Promise((resolve) => setImmediate(resolve));

    let newcomer = null;
    try {
      const started = performance.now();
      newcomer = await attachSession({ discovery, cwd: process.cwd() });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 100, `registration waited ${elapsed.toFixed(1)}ms behind session calls`);
    } finally {
      await newcomer?.close('control-plane test');
      await work;
      await client.close('control-plane test');
    }
  }, {
    sessionFactory: async () => ({
      ...createStubSessionRuntime(),
      getTheme(index) {
        const deadline = performance.now() + 5;
        while (performance.now() < deadline) { /* deliberate synchronous slice */ }
        return index;
      },
    }),
  });
});

test('independent clients and sessions start without waiting for another backlog', async () => {
  const started = [];
  const gates = new Map();
  let releaseAll = false;
  const gateFor = (label) => {
    if (releaseAll) return Promise.resolve(label);
    const gate = Promise.withResolvers();
    gates.set(label, gate);
    return gate.promise;
  };
  await withDaemon(async ({ discovery }) => {
    const noisy = await attachSession({
      discovery, cwd: process.cwd(), leadPid: process.pid,
    });
    const victim = await attachSession({
      discovery, cwd: process.cwd(), leadPid: process.ppid,
    });
    const { sessionId } = await noisy.call('session.create', { cwd: process.cwd() });
    const noisyWork = Array.from({ length: 60 }, (_, index) =>
      noisy.call('session.read', {
        sessionId,
        action: 'getProfile',
        args: [`noisy-${index}`],
      }, { callId: `fair-noisy-${index}` }));
    let victimWork = null;
    try {
      await waitFor(
        () => started.length === noisyWork.length,
        'noisy session starts its full parallel wave',
      );
      victimWork = victim.call('session.read', {
        sessionId,
        action: 'getProfile',
        args: ['victim'],
      }, { callId: 'fair-victim' });
      await waitFor(() => started.includes('victim'), 'victim starts without a permit release');
      const victimIndex = started.indexOf('victim');
      assert.equal(victimIndex, noisyWork.length);
    } finally {
      releaseAll = true;
      for (const gate of gates.values()) gate.resolve();
      await Promise.allSettled([...noisyWork, ...(victimWork ? [victimWork] : [])]);
      await victim.close('fairness test');
      await noisy.close('fairness test');
    }
  }, {
    sessionFactory: async () => ({
      ...createStubSessionRuntime(),
      getProfile(label) {
        started.push(label);
        return gateFor(label);
      },
    }),
  });
});

test('channel calls start a second client without a synthetic global permit', async () => {
  const started = [];
  const gates = new Map();
  let releaseAll = false;
  const gateFor = (label) => {
    if (releaseAll) return Promise.resolve(label);
    const gate = Promise.withResolvers();
    gates.set(label, gate);
    return gate.promise;
  };
  const transport = createChannelTransport({
    handleCall(_name, args) {
      const label = String(args?.label || '');
      started.push(label);
      return gateFor(label);
    },
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  let noisyWork = [];
  let victimWork = null;
  try {
    const noisy = await daemonPost(discovery, '/client/register', {
      leadPid: process.pid, cwd: process.cwd(), passive: true,
    });
    const victim = await daemonPost(discovery, '/client/register', {
      leadPid: process.ppid, cwd: process.cwd(), passive: true,
    });
    noisyWork = Array.from({ length: 6 }, (_, index) =>
      daemonPost(discovery, '/call', {
        token: noisy.token,
        name: 'work',
        args: { label: `channel-noisy-${index}` },
        callId: `channel-noisy-${index}`,
      }));
    await waitFor(
      () => started.length === noisyWork.length,
      'channel borrower starts its full parallel wave',
    );
    victimWork = daemonPost(discovery, '/call', {
      token: victim.token,
      name: 'work',
      args: { label: 'channel-victim' },
      callId: 'channel-victim',
    });
    await waitFor(() => started.includes('channel-victim'), 'channel victim starts without a permit release');
    assert.equal(started.indexOf('channel-victim'), noisyWork.length);
  } finally {
    releaseAll = true;
    for (const gate of gates.values()) gate.resolve();
    await Promise.allSettled([...noisyWork, ...(victimWork ? [victimWork] : [])]);
    await transport.stop();
  }
});
