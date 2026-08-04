import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AUTO_CLEAR_PROVIDER_IDLE_MS,
  resolveAgentTerminalReapMs,
} from '../src/session-runtime/config-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-terminal-reap-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_AGENT_TERMINAL_REAP_MS = '1';

function assertEqual(actual, expected, label) {
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

try {
  const builtIns = Object.entries(AUTO_CLEAR_PROVIDER_IDLE_MS).filter(([provider]) => provider !== 'default');
  for (const [provider, idleMs] of builtIns) {
    assertEqual(resolveAgentTerminalReapMs({ autoClear: {} }, provider), idleMs, `${provider} built-in`);
  }

  const overrideConfig = {
    autoClear: {
      idleMs: 12 * 60 * 60 * 1000,
      providerIdleMs: { 'openai-oauth': 60_000, default: 90_000, unlisted: 60_000 },
    },
  };
  assertEqual(resolveAgentTerminalReapMs(overrideConfig, 'openai-oauth'), 60_000, 'provider override');
  assertEqual(
    resolveAgentTerminalReapMs(overrideConfig, 'anthropic'),
    AUTO_CLEAR_PROVIDER_IDLE_MS.anthropic,
    'global idleMs and default row are ignored for listed providers',
  );
  assert.equal(resolveAgentTerminalReapMs(overrideConfig, 'default'), 90_000, 'default row applies to default provider');
  assert.equal(resolveAgentTerminalReapMs(overrideConfig, 'unlisted'), 90_000, 'default row applies to unlisted provider');
  assert.equal(resolveAgentTerminalReapMs({ autoClear: {} }, 'unknown'), AUTO_CLEAR_PROVIDER_IDLE_MS.default, 'unknown provider uses built-in default');

  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(join(root, 'mixdog-config.json'), JSON.stringify({
    agent: { autoClear: overrideConfig.autoClear },
  }));
  const {
    deleteSession,
    markSessionClosed,
    saveSession,
    sweepStaleSessions,
  } = await import('../src/runtime/agent/orchestrator/session/store.mjs');
  const old = Date.now() - 181_000;
  const known = {
    id: 'sess_known_reap',
    owner: 'agent',
    status: 'idle',
    provider: 'openai-oauth',
    createdAt: old,
    updatedAt: old,
    messages: [],
  };
  const shortOverride = {
    id: 'sess_short_override',
    owner: 'agent',
    status: 'idle',
    provider: 'openai-oauth',
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 120_000,
    messages: [],
  };
  const unknown = {
    id: 'sess_unknown_keep',
    owner: 'agent',
    status: 'idle',
    provider: 'unlisted',
    createdAt: old,
    updatedAt: old,
    messages: [],
  };
  const retainedParent = {
    id: 'sess_retained_agent_parent',
    owner: 'user',
    status: 'idle',
    createdAt: old,
    updatedAt: old,
    messages: [{ role: 'user', content: 'parent history retains its child' }],
  };
  const retainedChild = {
    ...known,
    id: 'sess_retained_linked_agent',
    ownerSessionId: retainedParent.id,
    parentSessionId: retainedParent.id,
    messages: [{ role: 'assistant', content: 'linked child transcript survives' }],
  };
  for (const session of [known, shortOverride, unknown, retainedParent, retainedChild]) {
    writeFileSync(join(root, 'sessions', `${session.id}.json`), JSON.stringify(session));
  }
  for (const id of [known.id, unknown.id, retainedParent.id, retainedChild.id]) {
    utimesSync(join(root, 'sessions', `${id}.json`), old / 1000, old / 1000);
  }
  utimesSync(join(root, 'sessions', `${shortOverride.id}.json`), shortOverride.updatedAt / 1000, shortOverride.updatedAt / 1000);
  const defaultSweep = sweepStaleSessions({ retainOpenSessions: false });
  assert.ok(
    defaultSweep.details.some((detail) => detail.id === shortOverride.id),
    'short provider override bypasses the default sweep freshness gate',
  );
  assert.ok(defaultSweep.details.some((detail) => detail.id === known.id), 'store reaps a listed provider at its Advanced duration');
  assert.ok(defaultSweep.details.some((detail) => detail.id === unknown.id), 'store reaps an unlisted provider at the default duration');
  assert.ok(!defaultSweep.details.some((detail) => detail.id === retainedChild.id), 'linked agent follows parent retention instead of provider reap');
  assert.notEqual(JSON.parse(readFileSync(join(root, 'sessions', `${retainedChild.id}.json`), 'utf8')).closed, true);

  const oldClosedChild = {
    ...retainedChild,
    id: 'sess_retained_closed_linked_agent',
    closed: true,
    status: 'closed',
    updatedAt: Date.now() - 2 * 60 * 60 * 1000,
  };
  const oldClosedChildPath = join(root, 'sessions', `${oldClosedChild.id}.json`);
  writeFileSync(oldClosedChildPath, JSON.stringify(oldClosedChild));
  utimesSync(oldClosedChildPath, oldClosedChild.updatedAt / 1000, oldClosedChild.updatedAt / 1000);
  const linkedTombstoneSweep = sweepStaleSessions({
    sweepIdle: false,
    tombstoneMaxAgeMs: 1,
  });
  assert.ok(!linkedTombstoneSweep.tombstoneDetails.some((detail) => detail.id === oldClosedChild.id),
    'legacy child tombstone survives while its parent file exists');
  assert.ok(existsSync(oldClosedChildPath));
  assert.deepEqual(
    (await import('../src/runtime/agent/orchestrator/session/store.mjs'))
      .listOwnedAgentSessionIds(retainedParent.id).sort(),
    [oldClosedChild.id, retainedChild.id].sort(),
  );

  const locallyLive = {
    ...known,
    id: 'sess_locally_live_keep',
  };
  writeFileSync(join(root, 'sessions', `${locallyLive.id}.json`), JSON.stringify(locallyLive));
  utimesSync(join(root, 'sessions', `${locallyLive.id}.json`), old / 1000, old / 1000);
  const protectedSweep = sweepStaleSessions({
    retainOpenSessions: false,
    isSessionLive: (id) => id === locallyLive.id,
  });
  assert.ok(!protectedSweep.details.some((detail) => detail.id === locallyLive.id), 'store does not reap a locally live stale session');
  assert.notEqual(JSON.parse(readFileSync(join(root, 'sessions', `${locallyLive.id}.json`), 'utf8')).closed, true);
  const settledSweep = sweepStaleSessions({ retainOpenSessions: false });
  assert.ok(settledSweep.details.some((detail) => detail.id === locallyLive.id), 'store reaps the session once local work settles');

  const heartbeatRace = {
    ...known,
    id: 'sess_heartbeat_race_keep',
  };
  const heartbeatRacePath = join(root, 'sessions', `${heartbeatRace.id}.json`);
  writeFileSync(heartbeatRacePath, JSON.stringify(heartbeatRace));
  utimesSync(heartbeatRacePath, old / 1000, old / 1000);
  let livenessChecks = 0;
  const heartbeatRaceSweep = sweepStaleSessions({
    retainOpenSessions: false,
    isSessionLive: (id) => {
      if (id !== heartbeatRace.id) return false;
      livenessChecks++;
      if (livenessChecks === 3) {
        writeFileSync(join(root, 'sessions', `${id}.hb`), '');
      }
      return false;
    },
  });
  assert.ok(livenessChecks >= 3, 'store performs the final runtime probe before taking the close lock');
  assert.ok(!heartbeatRaceSweep.details.some((detail) => detail.id === heartbeatRace.id), 'heartbeat landing before the locked re-stat vetoes close');
  assert.notEqual(JSON.parse(readFileSync(heartbeatRacePath, 'utf8')).closed, true);

  const retentionHeartbeat = {
    ...known,
    id: 'sess_retention_heartbeat_keep',
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
  };
  const retentionPath = join(root, 'sessions', `${retentionHeartbeat.id}.json`);
  writeFileSync(retentionPath, JSON.stringify(retentionHeartbeat));
  let retentionLivenessChecks = 0;
  const retentionSweep = sweepStaleSessions({
    ttlMs: 60_000,
    openMaxAgeMs: 24 * 60 * 60 * 1000,
    openMaxCount: 0,
    isSessionLive: (id) => {
      if (id !== retentionHeartbeat.id) return false;
      retentionLivenessChecks++;
      if (retentionLivenessChecks === 2) {
        writeFileSync(join(root, 'sessions', `${id}.hb`), '');
      }
      return false;
    },
  });
  assert.ok(retentionLivenessChecks >= 2, 'retention performs its runtime probe before taking the delete lock');
  assert.ok(!retentionSweep.openPrunedDetails.some((detail) => detail.id === retentionHeartbeat.id), 'commit-edge heartbeat vetoes retention hard-delete');
  assert.ok(existsSync(retentionPath), 'heartbeating retention candidate survives');

  const pendingClose = { ...known, id: 'sess_vetoed_close_pending', messages: [] };
  const pendingDelete = { ...known, id: 'sess_vetoed_delete_pending', messages: [] };
  for (const session of [pendingClose, pendingDelete]) {
    writeFileSync(join(root, 'sessions', `${session.id}.json`), JSON.stringify(session));
    saveSession({ ...session, messages: [{ role: 'user', content: 'pending save survived' }] });
  }
  assert.equal(markSessionClosed(pendingClose.id, 'idle-sweep', { isSessionLive: () => true }), null);
  assert.equal(deleteSession(pendingDelete.id, { isSessionLive: () => true }), false);
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const session of [pendingClose, pendingDelete]) {
    const saved = JSON.parse(readFileSync(join(root, 'sessions', `${session.id}.json`), 'utf8'));
    assert.equal(saved.messages[0]?.content, 'pending save survived', 'veto leaves debounce persistence intact');
    assert.notEqual(saved.closed, true);
  }

  const {
    _clearSessionRuntime,
    _getRuntimeEntry,
    markSessionAskStart,
  } = await import('../src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');
  const {
    _finalizeSweptSessionRuntime,
    _runCleanupCycle,
  } = await import('../src/runtime/agent/orchestrator/session/manager/idle-cleanup.mjs');

  const busy = {
    ...known,
    id: 'sess_unrelated_busy_keep',
    status: 'running',
  };
  const terminalDuringBusy = {
    ...known,
    id: 'sess_terminal_during_busy_reap',
  };
  for (const session of [busy, terminalDuringBusy]) {
    const path = join(root, 'sessions', `${session.id}.json`);
    writeFileSync(path, JSON.stringify(session));
    utimesSync(path, old / 1000, old / 1000);
  }
  markSessionAskStart(busy.id);
  const busyEntry = _getRuntimeEntry(busy.id);
  busyEntry.controller = new AbortController();
  await _runCleanupCycle();
  assert.notEqual(JSON.parse(readFileSync(join(root, 'sessions', `${busy.id}.json`), 'utf8')).closed, true, 'unrelated busy runtime survives idle cleanup');
  assert.equal(JSON.parse(readFileSync(join(root, 'sessions', `${terminalDuringBusy.id}.json`), 'utf8')).closed, true, 'terminal session is reaped while unrelated runtime is busy');

  const postScanRaceId = 'sess_post_scan_active_veto';
  markSessionAskStart(postScanRaceId);
  const postScanEntry = _getRuntimeEntry(postScanRaceId);
  postScanEntry.controller = new AbortController();
  assert.equal(_finalizeSweptSessionRuntime({ id: postScanRaceId }), false, 'post-scan activity vetoes runtime cleanup');
  assert.equal(postScanEntry.controller.signal.aborted, false, 'post-scan controller is not aborted');
  assert.equal(_getRuntimeEntry(postScanRaceId), postScanEntry, 'post-scan runtime remains owned');
  _clearSessionRuntime(busy.id);
  _clearSessionRuntime(postScanRaceId);

  // ── Runtime-only unload boundary (finished process-local agent) ─────────
  // A completed worker must release its heavy process-local runtime at once
  // WITHOUT terminalizing the persisted session: the same-tag follow-up
  // contract depends on that session file staying open and resumable.
  const { unloadSessionRuntime, closeSession } = await import('../src/runtime/agent/orchestrator/session/manager/session-close.mjs');
  const { markSessionDone } = await import('../src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');

  const unloadTarget = {
    ...known,
    id: 'sess_runtime_unload_keep',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    generation: 4,
    messages: [{ role: 'user', content: 'worker transcript survives unload' }],
    implicitBashSessionId: 'bash_unload_probe',
    allBashSessionIds: ['bash_unload_probe'],
  };
  const unloadPath = join(root, 'sessions', `${unloadTarget.id}.json`);
  writeFileSync(unloadPath, JSON.stringify(unloadTarget));

  markSessionAskStart(unloadTarget.id);
  const unloadEntry = _getRuntimeEntry(unloadTarget.id);
  unloadEntry.controller = new AbortController();
  assert.equal(unloadSessionRuntime(unloadTarget.id, 'test-inflight'), false, 'in-flight session is never unloaded');
  assert.equal(unloadEntry.controller.signal.aborted, false, 'unload never aborts a live controller');
  assert.equal(_getRuntimeEntry(unloadTarget.id), unloadEntry, 'vetoed unload leaves the runtime entry owned');

  // closed=true is not an exemption: a closing turn is still unwinding its
  // provider call (closeSession sets closed + stage='cancelling' and defers
  // the runtime clear), and a failed close barrier leaves a live controller.
  unloadEntry.closed = true;
  unloadEntry.stage = 'cancelling';
  assert.equal(unloadSessionRuntime(unloadTarget.id, 'test-closed-cancelling'), false, 'closed+cancelling session is never unloaded');
  assert.equal(unloadEntry.controller.signal.aborted, false, 'closed+cancelling unload never aborts the controller');
  assert.equal(_getRuntimeEntry(unloadTarget.id), unloadEntry, 'closed+cancelling unload leaves the runtime entry owned');
  unloadEntry.stage = 'streaming';
  assert.equal(unloadSessionRuntime(unloadTarget.id, 'test-closed-streaming'), false, 'closed session in a blocked stage is never unloaded');
  assert.equal(_getRuntimeEntry(unloadTarget.id), unloadEntry, 'closed+blocked-stage unload touches nothing');
  unloadEntry.stage = 'done';
  assert.equal(unloadSessionRuntime(unloadTarget.id, 'test-closed-live-controller'), false, 'closed session with an unaborted controller is never unloaded');
  assert.equal(unloadEntry.controller.signal.aborted, false, 'closed+live-controller unload never aborts the controller');
  assert.equal(_getRuntimeEntry(unloadTarget.id), unloadEntry, 'closed+live-controller unload leaves the runtime entry owned');
  assert.notEqual(JSON.parse(readFileSync(unloadPath, 'utf8')).closed, true, 'vetoed unloads never touch the persisted session');
  unloadEntry.closed = false;

  markSessionDone(unloadTarget.id);
  unloadEntry.controller = null;
  assert.equal(unloadSessionRuntime(unloadTarget.id, 'agent-turn-complete'), true, 'settled session unloads its runtime');
  assert.equal(_getRuntimeEntry(unloadTarget.id), undefined, 'unload drops the live runtime entry');
  const afterUnload = JSON.parse(readFileSync(unloadPath, 'utf8'));
  assert.notEqual(afterUnload.closed, true, 'unload never tombstones the persisted session');
  assert.equal(afterUnload.generation, unloadTarget.generation, 'unload never bumps the lifecycle generation');
  assert.equal(afterUnload.messages[0]?.content, 'worker transcript survives unload', 'unload preserves task transcript/meta');
  assert.equal(unloadSessionRuntime(unloadTarget.id, 'agent-turn-complete'), true, 'unload is idempotent');
  assert.notEqual(JSON.parse(readFileSync(unloadPath, 'utf8')).closed, true, 'repeat unload still leaves the session resumable');

  // Contrast: closeSession IS the terminal path — proves the unload above is
  // a genuinely different boundary, not an alias.
  const closeRef = { ...unloadTarget, id: 'sess_runtime_unload_close_ref' };
  const closeRefPath = join(root, 'sessions', `${closeRef.id}.json`);
  writeFileSync(closeRefPath, JSON.stringify(closeRef));
  assert.equal(closeSession(closeRef.id, 'test-close'), true, 'closeSession still terminalizes');
  assert.equal(JSON.parse(readFileSync(closeRefPath, 'utf8')).closed, true, 'closeSession plants the tombstone');

  const dataDir = join(root, 'worker-index');
  mkdirSync(dataDir, { recursive: true });
  const { createTagRegistry } = await import('../src/standalone/agent-tool/tag-registry.mjs');
  const timerSession = {
    ...retainedChild,
    id: 'sess_timer_reap_retained',
    agentTag: 'timer-retained',
    provider: 'openai-oauth',
  };
  let timerCloses = 0;
  let timerUnloads = 0;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => ({
    run: callback,
    unref() {},
  });
  globalThis.clearTimeout = () => {};
  const timerRegistry = createTagRegistry({
    dataDir,
    cfgMod: {
      loadConfig: () => ({ autoClear: { providerIdleMs: { 'openai-oauth': 1 } } }),
    },
    mgr: {
      getSession: (id) => id === timerSession.id ? timerSession : null,
      listSessions: () => [],
      closeSession: () => { timerCloses += 1; return true; },
      unloadSessionRuntime: () => { timerUnloads += 1; return true; },
    },
    emitSubagentEvent: () => {},
  });
  try {
    timerRegistry.bindTag(timerSession.agentTag, timerSession);
    timerRegistry.scheduleReap(timerSession.id, timerSession.provider);
    timerRegistry.reapTimers.get(timerSession.id)?.run();
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
  assert.equal(timerCloses, 0, 'terminal tag reap never tombstones the retained transcript');
  assert.equal(timerUnloads, 1, 'terminal tag reap only retries runtime unload');

  writeFileSync(join(dataDir, 'agent-workers.json'), JSON.stringify({
    workers: {
      known: {
        tag: 'known',
        sessionId: 'sess_known_row',
        provider: 'openai-oauth',
        status: 'idle',
        updatedAt: new Date(old).toISOString(),
      },
      unknown: {
        tag: 'unknown',
        sessionId: 'sess_unknown_row',
        provider: 'unlisted',
        status: 'idle',
        updatedAt: new Date(old).toISOString(),
      },
    },
  }));
  const { createStandaloneAgent } = await import('../src/standalone/agent-tool.mjs');
  const agent = createStandaloneAgent({
    cfgMod: {
      loadConfig: () => overrideConfig,
      resolveRuntimeSpec: () => ({ lane: 'agent', scopeKey: 'terminal-reap', provider: 'openai-oauth', model: 'test' }),
    },
    reg: {},
    mgr: { listSessions: () => [], getSession: () => null },
    dataDir,
    cwd: root,
  });
  const workers = agent.getStatus().workers;
  assert.ok(!workers.some((worker) => worker.tag === 'known'), 'worker row expires at the provider duration');
  assert.ok(!workers.some((worker) => worker.tag === 'unknown'), 'unlisted worker row expires at the default duration');
  agent.closeAll('agent-terminal-reap-test');

  process.stdout.write(`agent terminal reap test passed (${builtIns.length} providers)\n`);
} finally {
  delete process.env.MIXDOG_AGENT_TERMINAL_REAP_MS;
  delete process.env.MIXDOG_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
}
