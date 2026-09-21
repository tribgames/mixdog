import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeardown } from './teardown.mjs';

function fixture({ session = { id: 's1', messages: [{ role: 'user', content: 'hi' }] }, flushConfig } = {}) {
  const calls = [];
  const state = { session, closeRequested: false };
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  const deps = {
    getSession: () => state.session,
    setSession: (value) => {
      state.session = value;
    },
    getMcpScopeId: () => 'scope-1',
    setCloseRequested: (value) => {
      state.closeRequested = value;
    },
    getMemoryModPromise: () => null,
    setMemoryModPromise: () => {},
    hooks: { dispatch: record('hooks.dispatch'), flushRules: record('hooks.flushRules') },
    hookCommonPayload: (payload) => payload,
    mgr: {
      closeSession: (...args) => {
        calls.push(['mgr.closeSession', ...args]);
        return true;
      },
      abortSessionTurn: (...args) => {
        calls.push(['mgr.abortSessionTurn', ...args]);
        return true;
      },
    },
    statusRoutes: { clearGatewaySessionRoute: record('clearGatewaySessionRoute') },
    channels: {
      stop: (...args) => {
        calls.push(['channels.stop', ...args]);
        return Promise.resolve();
      },
    },
    agentTool: { closeAll: record('agentTool.closeAll') },
    mcpClient: { disconnectAll: record('mcp.disconnectAll') },
    warmupTimers: { providerWarmupTimer: setTimeout(() => {}, 60_000) },
    prewarmTimers: { channelStartTimer: setTimeout(() => {}, 60_000) },
    flushAllConfigSavesAsync: flushConfig || (async () => calls.push(['flushConfig'])),
    withTeardownDeadline: async (work) => await work,
    closePatchRuntimeIfLoaded: (...args) => {
      calls.push(['closePatchRuntime', ...args]);
      return null;
    },
    closeNativeToolTransports: record('closeNativeToolTransports'),
    stopSelfUpdateBootCheck: record('stopSelfUpdateBootCheck'),
    invalidateContextStatusCache: record('invalidateContextStatusCache'),
    notificationListeners: new Set(),
    clearRuntimeNotifications: record('clearRuntimeNotifications'),
    goalRuntime: { close: () => calls.push(['goal.close']) },
    disposeSessionTitles: record('disposeSessionTitles'),
    disposeInternalTools: record('disposeInternalTools'),
    disposeGlobalExtensionSubscription: record('disposeGlobalExtensionSubscription'),
    abortActiveTurns: (error) => {
      calls.push(['abortActiveTurns', error.reason]);
      return false;
    },
    getReservedSessionId: () => 'reserved-1',
  };
  const teardown = createTeardown(deps, {
    ingestSessionIntoMemory: async (s) => calls.push(['ingest', s?.id ?? null]),
    closeSurfaceSession: (s, reason, opts) => {
      calls.push(['closeSurfaceSession', s.id, reason, opts]);
      return true;
    },
    cancelBackgroundTasks: record('cancelBackgroundTasks'),
  });
  const named = (name) => calls.filter(([n]) => n === name);
  const cleanup = () => {
    clearTimeout(deps.warmupTimers.providerWarmupTimer);
    clearTimeout(deps.prewarmTimers.channelStartTimer);
  };
  return { teardown, deps, calls, state, named, cleanup };
}

test("close on process exit reaps every session's work and tombstones only a scratch session", async () => {
  const f = fixture();
  assert.equal(await f.teardown.close('cli-exit'), true);
  assert.equal(f.state.closeRequested, true);
  assert.equal(f.state.session, null);
  assert.deepEqual(f.named('cancelBackgroundTasks'), [
    ['cancelBackgroundTasks', { reason: 'cli-exit', notify: false }],
  ]);
  assert.deepEqual(f.named('agentTool.closeAll'), [['agentTool.closeAll', 'cli-exit', {}]]);
  assert.deepEqual(f.named('closeSurfaceSession'), [['closeSurfaceSession', 's1', 'cli-exit', { tombstone: false }]]);
  assert.deepEqual(f.named('hooks.dispatch'), [['hooks.dispatch', 'SessionEnd', { session_id: 's1', reason: 'exit' }]]);
  assert.deepEqual(f.named('mcp.disconnectAll'), [['mcp.disconnectAll', { scopeId: 'scope-1' }]]);
  assert.deepEqual(f.named('closeNativeToolTransports'), [['closeNativeToolTransports', 'cli-exit']]);
  assert.equal(f.deps.warmupTimers.providerWarmupTimer, null);
  assert.equal(f.deps.prewarmTimers.channelStartTimer, null);
  // Order: SessionEnd hook → memory ingest → config flush → session close.
  const order = f.calls.map(([n]) => n);
  assert.ok(order.indexOf('hooks.dispatch') < order.indexOf('ingest'));
  assert.ok(order.indexOf('ingest') < order.indexOf('flushConfig'));
  assert.ok(order.indexOf('flushConfig') < order.indexOf('closeSurfaceSession'));
  f.cleanup();
});

test("a non-exit close reaps only this session's work, with notification", async () => {
  const f = fixture();
  await f.teardown.close('dispose', { detach: true });
  assert.deepEqual(f.named('cancelBackgroundTasks'), [
    ['cancelBackgroundTasks', { reason: 'dispose', notify: true, callerSessionId: 's1' }],
  ]);
  assert.deepEqual(f.named('agentTool.closeAll'), [['agentTool.closeAll', 'dispose', { callerSessionId: 's1' }]]);
  assert.deepEqual(f.named('closePatchRuntime'), [['closePatchRuntime', { waitForExit: false }]]);
  assert.deepEqual(f.named('channels.stop'), [
    ['channels.stop', 'dispose', { waitForExit: false, preserveRemoteIntent: true }],
  ]);
  assert.deepEqual(f.named('closeNativeToolTransports'), []);
  assert.deepEqual(f.named('hooks.dispatch'), [
    ['hooks.dispatch', 'SessionEnd', { session_id: 's1', reason: 'other' }],
  ]);
  f.cleanup();
});

test('keepBackgroundWork leaves jobs and agent workers to the re-materialized owner', async () => {
  const f = fixture();
  await f.teardown.close('idle-evict', { keepBackgroundWork: true });
  assert.deepEqual(f.named('cancelBackgroundTasks'), []);
  assert.deepEqual(f.named('agentTool.closeAll'), []);
  assert.equal(f.named('goal.close').length, 1);
  f.cleanup();
});

test('a scratch session is tombstoned and an empty runtime closes without a session', async () => {
  const scratch = fixture({ session: { id: 's2', messages: [] } });
  await scratch.teardown.close('cli-exit');
  assert.deepEqual(scratch.named('closeSurfaceSession'), [
    ['closeSurfaceSession', 's2', 'cli-exit', { tombstone: true }],
  ]);
  scratch.cleanup();

  const empty = fixture({ session: null });
  assert.equal(await empty.teardown.close('cli-exit'), false);
  assert.deepEqual(empty.named('hooks.dispatch'), []);
  assert.deepEqual(empty.named('cancelBackgroundTasks'), [
    ['cancelBackgroundTasks', { reason: 'cli-exit', notify: false }],
  ]);
  empty.cleanup();
});

test('closeCanonicalSession plants the tombstone barrier without whole-process teardown', () => {
  const f = fixture();
  assert.equal(f.teardown.closeCanonicalSession(), true);
  assert.deepEqual(f.named('mgr.closeSession'), [
    ['mgr.closeSession', 's1', 'canonical-session-close', { tombstone: true }],
  ]);
  assert.equal(f.state.session, null);
  assert.deepEqual(f.named('channels.stop'), []);
  const attached = fixture({ session: { id: 's3', remoteAttached: true } });
  assert.equal(attached.teardown.closeCanonicalSession(), false);
  attached.cleanup();
  f.cleanup();
});

test('a config flush failure at teardown is reported instead of silently losing the write', async () => {
  const f = fixture({
    flushConfig: async () => {
      throw new Error('config lock busy');
    },
  });
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    assert.equal(await f.teardown.close('cli-exit'), true, 'teardown still completes');
    await new Promise((resolve) => setImmediate(resolve));
    const flushWarnings = warnings.filter((warning) => warning.code === 'TEARDOWN_CONFIG_FLUSH_FAILED');
    assert.equal(flushWarnings.length, 1);
    assert.match(flushWarnings[0].message, /config lock busy/);
    assert.deepEqual(f.named('closeSurfaceSession'), [['closeSurfaceSession', 's1', 'cli-exit', { tombstone: false }]]);
  } finally {
    process.off('warning', onWarning);
    f.cleanup();
  }
});

test('abort reports whether the outer turn or the manager turn was aborted', () => {
  const f = fixture();
  assert.equal(f.teardown.abort('cli-abort'), true);
  assert.deepEqual(f.named('abortActiveTurns'), [['abortActiveTurns', 'cli-abort']]);
  assert.deepEqual(f.named('mgr.abortSessionTurn'), [['mgr.abortSessionTurn', 's1', 'cli-abort']]);
  const empty = fixture({ session: null });
  assert.equal(empty.teardown.abort(), false);
  empty.cleanup();
  f.cleanup();
});
