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
  writeFileSync(join(root, 'sessions', `${known.id}.json`), JSON.stringify(known));
  writeFileSync(join(root, 'sessions', `${shortOverride.id}.json`), JSON.stringify(shortOverride));
  writeFileSync(join(root, 'sessions', `${unknown.id}.json`), JSON.stringify(unknown));
  for (const id of [known.id, unknown.id]) utimesSync(join(root, 'sessions', `${id}.json`), old / 1000, old / 1000);
  utimesSync(join(root, 'sessions', `${shortOverride.id}.json`), shortOverride.updatedAt / 1000, shortOverride.updatedAt / 1000);
  const defaultSweep = sweepStaleSessions({ retainOpenSessions: false });
  assert.ok(
    defaultSweep.details.some((detail) => detail.id === shortOverride.id),
    'short provider override bypasses the default sweep freshness gate',
  );
  assert.ok(defaultSweep.details.some((detail) => detail.id === known.id), 'store reaps a listed provider at its Advanced duration');
  assert.ok(defaultSweep.details.some((detail) => detail.id === unknown.id), 'store reaps an unlisted provider at the default duration');

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
  _runCleanupCycle();
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

  const dataDir = join(root, 'worker-index');
  mkdirSync(dataDir, { recursive: true });
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
