import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupBackgroundTasks,
  completeBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
  attachSession,
  createSession,
  createStubSessionRuntime,
  withDaemon,
  waitFor,
} from './_shared.mjs';


test('the daemon signals shutdown once the last view leaves', async () => {
  await withDaemon(async ({ discovery, clientsEmpty }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    await client.call('session.create', { cwd: process.cwd() });
    await client.close('test');
    await waitFor(() => clientsEmpty() === 'empty', 'client grace elapses into shutdown');
  });
});

test('resuming a session another view already holds converges on one owner', async () => {
  await withDaemon(async ({ service }) => {
    const terminal = await createSession({ cwd: process.cwd() });
    const desktop = await createSession({ cwd: process.cwd() });
    assert.equal(service.size, 2, 'each new-task view starts with a reserved session');

    await terminal.resume('shared-session');
    await waitFor(() => terminal.getState().sessionId === 'shared-session',
      'the terminal view holds the resumed session');

    // The desktop resumes the SAME session: it joins the same daemon owner.
    await desktop.resume('shared-session');
    assert.equal(desktop.getState().sessionId, terminal.getState().sessionId);
    await waitFor(() => service.size === 1, 'unclaimed reservations are reclaimed internally');

    await desktop.submit('typed in the desktop');
    await waitFor(() => terminal.getState().items.some((item) => item.text === 'typed in the desktop'),
      'the terminal view sees the desktop edit on the shared runtime');

    await terminal.submit('typed in the terminal');
    await waitFor(() => desktop.getState().items.some((item) => item.text === 'typed in the terminal'),
      'the desktop view sees the terminal edit on the shared runtime');

    await desktop.dispose('test');
    await terminal.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('a method return leaves the view consistent immediately', async () => {
  await withDaemon(async () => {
    const view = await createSession({ cwd: process.cwd() });
    // No await on a frame: the session projection is consistent the instant
    // the method returns.
    await view.resume('immediate-session');
    assert.equal(view.getState().sessionId, 'immediate-session');
    // submit is part of the SYNCHRONOUS store surface: it accepts inline and
    // the transcript follows, exactly like the in-process store.
    assert.equal(view.submit('immediate'), true);
    await waitFor(() => view.getState().items.at(-1)?.text === 'immediate',
      'the submitted item lands in the view');
    await view.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('a working runtime outlives its last view and the next one rejoins it', async () => {
  await withDaemon(async ({ service }) => {
    const before = await createSession({ cwd: process.cwd() });
    await before.resume('long-running');
    await before.setProgressHint('working');
    assert.equal(before.getState().busy, true, 'the runtime is mid-turn');

    // The app quits / the terminal is restarted while the turn runs.
    await before.dispose('app restart');
    assert.equal(service.size, 1, 'the daemon keeps running the turn with no views attached');

    // The client comes back and resumes the same session.
    const after = await createSession({ cwd: process.cwd() });
    await after.resume('long-running');
    assert.equal(after.getState().busy, true, 'the returning view rejoins the live turn');
    assert.ok(after.getState().items.some((item) => item.text === 'working'),
      'the transcript produced while nobody watched is still there');
    assert.equal(service.size, 1, 'no second runtime was created for the same session');

    await after.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('an unwatched runtime retains its CC-style background task until completion', async () => {
  const taskId = `session-retention-shell-${Date.now()}`;
  let ownerSessionId = '';
  let cancelled = 0;
  try {
    await withDaemon(async ({ discovery, service }) => {
      const client = await attachSession({ discovery, cwd: process.cwd() });
      try {
        const created = await client.call('session.create', { cwd: process.cwd() });
        ownerSessionId = created.sessionId;
        registerBackgroundTask({
          taskId,
          surface: 'shell',
          operation: 'shell',
          label: 'retained shell task',
          context: { callerSessionId: ownerSessionId },
          cancel: () => { cancelled += 1; },
        });
        await client.call('session.unsubscribe', { sessionId: ownerSessionId });

        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(service.size, 1, 'idle eviction must not cancel owner background work');
        assert.equal(service.busyCount, 1, 'daemon shutdown guard sees background work');
        assert.equal(service.status.busy, 1, 'session status reports background work');
        assert.equal(getBackgroundTask(taskId)?.status, 'running');

        completeBackgroundTask(taskId, {
          status: 'completed',
          resultText: 'retained completion',
          notify: false,
        });
        await waitFor(
          () => service.size === 0,
          'the runtime is reclaimed only after its background task completes',
        );
        assert.equal(cancelled, 0, 'idle eviction never owns task cancellation');
      } finally {
        await client.close('background retention test');
      }
    }, {
      idleEvictMs: 15,
      evictSweepMs: 5,
      sessionFactory: async () => createStubSessionRuntime(''),
    });
  } finally {
    cleanupBackgroundTasks({
      force: true,
      callerSessionId: ownerSessionId,
      surface: 'shell',
    });
  }
});

test('auto-background task elapsed time includes its foreground phase', () => {
  const taskId = `shell-total-elapsed-${Date.now()}`;
  const startedAtMs = Date.now() - 16_000;
  const task = registerBackgroundTask({
    taskId,
    startedAtMs,
    surface: 'shell',
    operation: 'shell',
    label: 'foreground then background',
  });
  assert.equal(task.startedAtMs, startedAtMs);
  assert.equal(Date.parse(task.startedAt), startedAtMs);
  completeBackgroundTask(taskId, {
    status: 'completed',
    resultText: 'done',
    notify: false,
  });
  cleanupBackgroundTasks({ force: true, surface: 'shell' });
});

test('session retention exposes no RSS growth ceiling', async () => {
  await withDaemon(async ({ service }) => {
    assert.equal(Object.hasOwn(service.status, 'softRssBytes'), false);
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('repeated idle session churn releases runtimes, projections, and its sweep timer', async () => {
  const rounds = 6;
  const sessionsPerRound = 24;
  const payloadChars = 256 * 1024;
  let disposed = 0;
  const heapSamples = [];

  await withDaemon(async ({ discovery, service }) => {
    const client = await attachSession({ discovery, cwd: process.cwd() });
    try {
      for (let round = 0; round < rounds; round += 1) {
        const ids = [];
        for (let index = 0; index < sessionsPerRound; index += 1) {
          const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
          ids.push(sessionId);
          await client.call('session.submit', {
            sessionId,
            prompt: `${round}:${index}:${'x'.repeat(payloadChars)}`,
          });
        }
        await Promise.all(ids.map((sessionId) =>
          client.call('session.unsubscribe', { sessionId })));
        const expectedDisposed = (round + 1) * sessionsPerRound;
        await waitFor(
          () => service.size === 0 && disposed === expectedDisposed,
          () => `idle churn retained ${service.size} runtime(s), disposed=${disposed}/${expectedDisposed}`,
        );
        assert.deepEqual(service.status, {
          live: 0,
          busy: 0,
          watched: 0,
          retained: 0,
          projected: 0,
          pendingViewerSessions: 0,
          evictionSweepActive: false,
        });
        if (global.gc) {
          global.gc();
          global.gc();
          await new Promise((resolve) => setImmediate(resolve));
          heapSamples.push(process.memoryUsage().heapUsed);
        }
      }
    } finally {
      await client.close('memory churn test');
    }
  }, {
    idleEvictMs: 15,
    evictSweepMs: 5,
    sessionFactory: async () => {
      const runtime = createStubSessionRuntime('');
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async (...args) => {
        disposed += 1;
        return dispose(...args);
      };
      return runtime;
    },
  });

  if (heapSamples.length > 1) {
    const growth = heapSamples.at(-1) - heapSamples[0];
    assert.ok(growth < 24 * 1024 * 1024,
      `heap grew ${(growth / 1024 / 1024).toFixed(1)}MB across reclaimed churn`);
  }
});

test('one client leaving never ends the runtime another client is watching', async () => {
  await withDaemon(async ({ discovery, service }) => {
    // Two SEPARATE clients (terminal process + desktop process), not two views
    // in one process: the mirror refcount inside a client cannot see the peer.
    const terminal = await attachSession({ discovery, cwd: process.cwd() });
    const desktop = await attachSession({
      discovery, cwd: process.cwd(),
    });
    const { sessionId } = await terminal.call('session.create', { cwd: process.cwd() });
    await desktop.call('session.subscribe', { sessionId });

    // The terminal quits.
    await terminal.close('terminal exit');
    assert.equal(service.size, 1, 'the session survives the terminal exit');

    // …and the desktop keeps working on the same session.
    await desktop.call('session.submit', { sessionId, prompt: 'after terminal exit' });
    const read = await desktop.call('session.read', { sessionId });
    assert.equal(read.full.items.at(-1).text, 'after terminal exit');

    // The last viewer leaving still does not end a materialized session.
    await desktop.call('session.unsubscribe', { sessionId });
    assert.equal(service.size, 1, 'a session-carrying runtime outlives every view');

    await desktop.close('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('a client that disappears releases its view without killing the runtime', async () => {
  await withDaemon(async ({ discovery, service }) => {
    const terminal = await attachSession({ discovery, cwd: process.cwd() });
    const desktop = await attachSession({ discovery, cwd: process.cwd() });
    const { sessionId } = await terminal.call('session.create', { cwd: process.cwd() });
    await desktop.call('session.subscribe', { sessionId });

    // Terminal window closed with no dispose at all (deregister only).
    await terminal.close('terminal closed');
    assert.equal(service.size, 1, 'a vanished client never takes the session from another viewer');
    const read = await desktop.call('session.read', { sessionId });
    assert.equal(read.sessionId, sessionId);

    // An unclaimed reservation is reclaimed by daemon policy, not client dispose.
    await desktop.call('session.unsubscribe', { sessionId });
    assert.equal(service.size, 0, 'an unclaimed reservation is reclaimed on unsubscribe');
    await desktop.close('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('closing every view never ends a live session runtime', async () => {
  await withDaemon(async ({ service }) => {
    const terminal = await createSession({ cwd: process.cwd() });
    await terminal.resume('kept-alive');
    await terminal.submit('half of a conversation');
    await waitFor(() => terminal.getState().items.length === 2, 'the session has content');

    // Idle, not busy, nobody watching — the old contract destroyed it here and
    // that is what cut a turn short when the other surface was still using it.
    await terminal.dispose('terminal exit');
    assert.equal(service.size, 1, 'the runtime belongs to the daemon, not to the view');

    // Coming back rejoins the SAME live runtime, in-memory state intact.
    const desktop = await createSession({ cwd: process.cwd() });
    await desktop.resume('kept-alive');
    assert.equal(service.size, 1, 'no second runtime was loaded for the session');
    assert.ok(desktop.getState().items.some((item) => item.text === 'half of a conversation'),
      'the returning view sees the live transcript, not a disk reload');
    await desktop.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});

test('a view told its session was unloaded comes back instead of stalling', async () => {
  await withDaemon(async ({ transport, service }) => {
    const view = await createSession({ cwd: process.cwd() });
    await view.resume('recovered-session');
    // The daemon announces an idle unload. The projection must subscribe again
    // without exposing or recovering an internal runtime handle.
    transport.broadcast({
      type: 'session-gone', key: 'session-state:recovered-session',
      sessionId: 'recovered-session', reason: 'evicted',
    });
    await waitFor(() => view.getState().sessionId === 'recovered-session' && service.size === 1,
      'the view rejoined the session');
    assert.equal(view.disposedView, false, 'the view stays usable');
    assert.equal(view.getState().sessionId, 'recovered-session', 'the session came back with it');

    assert.equal(view.submit('after recovery'), true);
    await waitFor(() => view.getState().items.some((item) => item.text === 'after recovery'),
      'a prompt sent after the recovery still reaches the runtime');

    await view.dispose('test');
  }, { sessionFactory: async () => createStubSessionRuntime('') });
});
