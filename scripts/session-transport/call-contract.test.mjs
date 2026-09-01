import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionService,
  SESSION_READ_ACTIONS,
  attachSession,
  createSession,
  probeSessionHealth,
  createSessionOAuthFlowRegistry,
  createStubSessionRuntime,
  withDaemon,
  waitFor,
  sessionSnapshotFromFrames,
} from './_shared.mjs';


test('daemon-owned OAuth flows expose serializable status, completion, and cancellation', async () => {
  const registry = createSessionOAuthFlowRegistry();
  let cancelled = 0;
  try {
    const started = registry.register({
      provider: 'anthropic-oauth',
      manualUrl: 'https://example.test/oauth',
      completeCode: async (code) => code === 'code-123',
    });
    assert.equal(started.state, 'pending');
    assert.equal(started.manualCodeSupported, true);
    assert.doesNotThrow(() => structuredClone(started));
    const completed = await registry.complete(started.flowId, 'code-123');
    assert.equal(completed.state, 'complete');
    assert.equal(completed.completed, true);

    const second = registry.register({
      provider: 'openai',
      cancel: async () => { cancelled += 1; },
    });
    const cancelledStatus = await registry.cancel(second.flowId);
    assert.equal(cancelledStatus.state, 'cancelled');
    assert.equal(cancelled, 1);
    // Terminal flows stay queryable (oauth-flows.test.mjs owns this contract);
    // only cancelAll() drops them from the registry.
    assert.equal(registry.status(second.flowId).state, 'cancelled');
  } finally {
    registry.cancelAll();
  }
});

test('session calls log only a bounded result summary, never the transcript body', async () => {
  const logs = [];
  const service = createSessionService({
    createSessionRuntime: async () => ({
      ...createStubSessionRuntime('bounded_log_session'),
      getSettingsSnapshot: () => ({
        items: Array.from({ length: 200 }, (_, index) => ({
          id: index,
          text: `private-transcript-${index}-${'x'.repeat(500)}`,
        })),
      }),
    }),
    log: (line) => logs.push(line),
  });
  try {
    const result = await service.handleCall('session.read', {
      sessionId: 'bounded_log_session',
      action: 'getSettingsSnapshot',
      args: [],
    }, { clientToken: 'bounded_log_client' });
    assert.equal(result.value.items.length, 200);
    const line = logs.find((entry) => entry.includes('session action getSettingsSnapshot'));
    assert.match(line, /result=object items=200/);
    assert.doesNotMatch(line, /private-transcript/);
    assert.ok(line.length < 200);
  } finally {
    await service.stop('test end');
  }
});

test('session catalog has one explicit route and never rides session responses', async () => {
  let scans = 0;
  const service = createSessionService({
    createSessionRuntime: async () => ({
      ...createStubSessionRuntime(),
      renameSessionTitle() { return true; },
    }),
    listSessions() {
      scans += 1;
      return [{ id: 'catalog-row', updatedAt: scans }];
    },
    getRemoteSessionState() {
      return { enabled: true, sessionId: 'catalog-row' };
    },
  });
  try {
    const firstCatalog = await service.handleCall('session.list', {});
    assert.ok(Array.isArray(firstCatalog.sessions));
    assert.deepEqual(firstCatalog.remoteSession, {
      enabled: true,
      sessionId: 'catalog-row',
    });
    assert.equal(scans, 1);
    const created = await service.handleCall('session.create', {});
    assert.equal(Object.hasOwn(created, 'sync'), false);
    const read = await service.handleCall('session.read', {
      sessionId: created.sessionId,
      baseRevision: created.revision,
    });
    assert.equal(Object.hasOwn(read, 'sync'), false);
    assert.equal(scans, 1, 'session reads do not scan or carry the catalog');
    const configured = await service.handleCall('session.configure', {
      sessionId: created.sessionId,
      action: 'renameSessionTitle',
      args: ['renamed'],
      baseRevision: read.revision,
    });
    assert.equal(Object.hasOwn(configured, 'sync'), false);
    const secondCatalog = await service.handleCall('session.list', {});
    assert.ok(Array.isArray(secondCatalog.sessions));
    assert.equal(scans, 2);
  } finally {
    await service.stop('test end');
  }
});

test('canonical session.read returns raw agent messages without a deprecated action', async () => {
  const messages = [
    { role: 'user', content: 'worker brief' },
    { role: 'assistant', content: 'worker handoff' },
  ];
  const runtime = createStubSessionRuntime('agent_read_session');
  assert.equal(Object.hasOwn(runtime, 'session'), false);
  const service = createSessionService({
    createSessionRuntime: async () => runtime,
    readStoredSession: async (_sessionId, options = {}) => ({
      items: [],
      ...(options.includeMessages === true ? { messages } : {}),
    }),
  });
  try {
    const result = await service.handleCall('session.read', {
      sessionId: 'agent_read_session',
      messageStart: 1,
    });
    assert.equal(result.messageCount, 2);
    assert.deepEqual(result.messages, [messages[1]]);
    assert.equal(SESSION_READ_ACTIONS.some((name) => /peek/i.test(name)), false);
  } finally {
    await service.stop('test end');
  }
});

test('call idempotency is isolated per client process', async () => {
  await withDaemon(async ({ discovery }) => {
    const first = await attachSession({
      discovery, cwd: process.cwd(), leadPid: process.pid,
    });
    const second = await attachSession({
      discovery, cwd: process.cwd(), leadPid: process.ppid,
    });
    const { sessionId } = await first.call('session.create', { cwd: process.cwd() });
    const args = { sessionId, prompt: 'same payload' };
    await first.call('session.submit', args, { callId: 'same-process-local-id' });
    await second.call('session.submit', args, { callId: 'same-process-local-id' });
    const read = await first.call('session.read', { sessionId });
    assert.equal(read.full.items.length, 2);
    await second.close('call cache isolation');
    await first.close('call cache isolation');
  });
});

test('session protocol ACKs intake and unsubscribe never interrupts execution', async () => {
  let finishWork = null;
  let abortCalls = 0;
  let eagerSessionCreates = 0;
  const sessionFactory = async () => {
    let state = { sessionId: '', items: [], busy: false };
    const listeners = new Set();
    const publish = () => { for (const listener of [...listeners]) listener(); };
    return {
      getState: () => state,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      reserveSession(id) {
        state = { ...state, sessionId: String(id) };
        publish();
        return true;
      },
      async newSession() {
        eagerSessionCreates += 1;
        state = { ...state, sessionId: 'durable-session' };
        publish();
        return true;
      },
      async resume(id) {
        state = { ...state, sessionId: String(id) };
        publish();
        return true;
      },
      async submitAsync(text) {
        state = {
          ...state,
          busy: true,
          items: [...state.items, { id: 'prompt', text: String(text) }],
        };
        publish();
        finishWork = () => {
          state = {
            ...state,
            busy: false,
            items: [...state.items, { id: 'answer', text: 'completed after detach' }],
          };
          publish();
        };
        return true;
      },
      abort() {
        abortCalls += 1;
        state = { ...state, busy: false };
        publish();
        return true;
      },
      resolveToolApproval() { return true; },
      async dispose() {},
    };
  };

  await withDaemon(async ({ discovery, service }) => {
    const terminalFrames = [];
    const terminal = await attachSession({
      discovery,
      cwd: process.cwd(),
      onFrame: (frame) => terminalFrames.push(frame),
    });
    const desktop = await attachSession({ discovery, cwd: process.cwd() });
    const created = await terminal.call('session.create', { cwd: process.cwd() });
    assert.match(created.sessionId, /^sess_daemon_/, 'create returns a daemon-reserved stable address');
    assert.ok(created.revision > 1_000_000_000_000,
      'default daemon revisions carry a restart-monotonic epoch');
    assert.equal(created.reservedOnly, true);
    assert.equal(eagerSessionCreates, 0, 'reservation does not eagerly materialize a provider session');
    const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
    assert.equal(subscribed.subscribed, true);

    const submitted = await terminal.call('session.submit', {
      sessionId: created.sessionId,
      prompt: 'keep running',
      options: { id: 'durable-submit' },
    }, { callId: 'session-submit:durable-session:durable-submit' });
    assert.equal(submitted.accepted, true, 'submit ACKs queue intake');
    assert.equal(submitted.reservedOnly, false);
    await waitFor(
      () => sessionSnapshotFromFrames(terminalFrames, created.sessionId)?.busy === true,
      'the session stream reports the accepted turn',
    );
    assert.equal(typeof finishWork, 'function', 'execution remains independently finishable after ACK');

    await desktop.call('session.unsubscribe', { sessionId: created.sessionId });
    await desktop.close('desktop closed');
    assert.equal(abortCalls, 0, 'unsubscribe and disconnect do not call abort');
    assert.equal(service.size, 1, 'the daemon still owns the session runtime');

    finishWork();
    const completed = await waitFor(
      () => {
        const snapshot = sessionSnapshotFromFrames(terminalFrames, created.sessionId);
        return snapshot?.items?.at(-1)?.text === 'completed after detach' ? snapshot : null;
      },
      'terminal observes completion after desktop detach',
    );
    assert.equal(completed.busy, false);
    assert.equal(abortCalls, 0);
    await terminal.call('session.unsubscribe', { sessionId: created.sessionId });
    await terminal.close('test');
  }, { sessionFactory });
});

test('session faults answer as call errors and non-serializable values are dropped', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    await assert.rejects(
      () => client.call('session.read', { sessionId, action: 'getProfile', args: [] }),
      /stub failure/,
    );
    await assert.rejects(
      () => client.call('session.read', { sessionId, action: 'getOutputStyle', args: [] }),
      /unavailable/,
    );
    const described = await client.call('session.read', { sessionId, action: 'getTheme', args: [] });
    assert.deepEqual(described.value, { ok: true, when: '1970-01-01T00:00:00.000Z' });
    await client.close('test');
  });
});

test('an addressed session action cannot silently move to another id', async () => {
  const sessionFactory = async () => {
    let state = { sessionId: '', items: [], queued: [], busy: false };
    const listeners = new Set();
    const publish = () => {
      for (const listener of [...listeners]) listener();
    };
    return {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reserveSession(id) {
        state = { ...state, sessionId: String(id) };
        publish();
        return true;
      },
      setRoute() {
        state = { ...state, sessionId: 'silently-rebound-session' };
        publish();
        return true;
      },
      async dispose() {},
    };
  };

  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const created = await client.call('session.create', {
      sessionId: 'addressed-session',
      cwd: process.cwd(),
    });
    assert.equal(created.sessionId, 'addressed-session');
    await assert.rejects(
      () => client.call('session.configure', {
        sessionId: created.sessionId,
        action: 'setRoute',
        args: [{ model: 'test-model', applyToCurrentSession: true }],
      }),
      /session addressed-session changed its durable address to silently-rebound-session/,
    );
    await client.close('address invariant verified');
  }, { sessionFactory });
});

test('a retried call with the same id runs exactly one runtime mutation', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const callId = 'stable-call-id';
    await client.call('session.submit', { sessionId, prompt: 'once' }, { callId });
    await client.call('session.submit', { sessionId, prompt: 'once' }, { callId });
    const read = await client.call('session.read', { sessionId });
    assert.equal(read.full.items.length, 1);
    await client.close('test');
  });
});

test('replay-safe session reads do not retain snapshots in the mutation cache', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const before = await probeSessionHealth(discovery);
    for (let index = 0; index < 20; index += 1) {
      await client.call('session.read', { sessionId }, { callId: `snapshot-read:${index}` });
    }
    const after = await probeSessionHealth(discovery);
    assert.equal(
      after?.transportMemory?.callCacheEntries,
      before?.transportMemory?.callCacheEntries,
    );
    await client.close('read cache verified');
  });
});

test('the remote session projection keeps the store contract', async () => {
  await withDaemon(async () => {
    const runtime = await createSession({ cwd: process.cwd() });
    assert.equal(runtime.isRemoteSession, true);
    assert.match(runtime.getState().sessionId, /^sess_daemon_/);

    let notified = 0;
    const unsubscribe = runtime.subscribe(() => { notified += 1; });
    assert.equal(await runtime.submit('through the proxy'), true);
    await waitFor(() => runtime.getState().items?.length === 1, 'proxy mirrors its own submission');
    assert.ok(notified > 0, 'subscribers observe the mirrored snapshot');
    await runtime.setProgressHint('working');
    const preserved = await runtime.abortAsync({ restorePrompt: false });
    assert.equal(preserved.aborted, true);
    assert.equal(preserved.restoreText, '', 'a replacement draft suppresses prompt rewind across the daemon');
    assert.equal(preserved.pastedImages, null);
    await runtime.setProgressHint('working');
    const interrupted = await runtime.abortAsync();
    assert.equal(interrupted.aborted, true);
    assert.equal(interrupted.restoreText, 'restored prompt');
    assert.deepEqual(interrupted.pastedImages, { image_1: { filename: 'restored.png' } });
    assert.equal(runtime.getState().busy, false);
    unsubscribe();

    // Revisions are local to a session projection. This old session has
    // advanced farther than the fresh reservation, but New task must still
    // replace its transcript from the lower-numbered full baseline.
    const previousSessionId = runtime.getState().sessionId;
    await runtime.newSession();
    assert.notEqual(runtime.getState().sessionId, previousSessionId);
    assert.deepEqual(runtime.getState().items, [],
      'a fresh New task never retains the previous session transcript');

    // A second view shares the process attachment but owns another session.
    const second = await createSession({ cwd: process.cwd() });
    assert.notEqual(second.getState().sessionId, runtime.getState().sessionId);
    await second.dispose('test');
    await runtime.dispose('test');
  });
});

test('reusing a mutation callId with a different payload fails closed', async () => {
  await withDaemon(async ({ discovery }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
    const callId = 'conflicting-call-id';
    await client.call('session.submit', { sessionId, prompt: 'first' }, { callId });
    await assert.rejects(
      () => client.call('session.submit', { sessionId, prompt: 'second' }, { callId }),
      /reused with a different payload/,
    );
    const read = await client.call('session.read', { sessionId });
    assert.equal(read.full.items.length, 1);
    assert.equal(read.full.items[0].text, 'first');
    await client.close('call conflict verified');
  });
});
