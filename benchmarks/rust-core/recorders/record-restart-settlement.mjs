#!/usr/bin/env node
// Golden twin of the worker-index restart settlement (`worker-index/restart-settlement.mjs`): which rows a
// startup recovery and a later (`deadOnly`) sweep settle, to what (idle, or failed with `process-restart` when
// another process ran the turn), which persisted approval waits clear, which failures are still owed to their
// owner, and what `markRestartNotified` stamps. The real settlement runs over an in-memory row store; only the
// config (terminal reap windows), the manager's "turn in flight" answer and the pids are given.
//
//   node benchmarks/rust-core/recorders/record-restart-settlement.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const NOW = Date.parse('2026-03-01T10:00:00.000Z');
Date.now = () => NOW;
const sandbox = mkdtempSync(join(tmpdir(), 'restart-settlement-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const tree = resolveTree(parseArgs());
const { createRestartSettlement } = await importFrom(tree, 'src/session-runtime/services/agent-tool/worker-index/restart-settlement.mjs');
const { workerRowKey } = await importFrom(tree, 'src/session-runtime/services/agent-tool/worker-rows.mjs');

const OWN = process.pid; // alive
const DEAD = 2147483646; // no such process
const iso = (offsetSeconds) => new Date(NOW + offsetSeconds * 1000).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));

let n = 0;
const row = (patch = {}) => {
  n += 1;
  return { tag: `t${n}`, sessionId: `sess_${n}`, agent: 'worker', provider: patch.provider ?? 'anthropic', ownerSessionId: 'lead-a', status: 'running', stage: 'running', updatedAt: iso(-30), startedAt: iso(-100), ...patch };
};

const ROWS = [
  row(),
  row({ runtimePid: OWN }),
  row({ runtimePid: DEAD }),
  row({ runtimePid: DEAD, status: 'idle', stage: 'idle' }),
  row({ updatedAt: iso(-600) }),
  row({ updatedAt: iso(-600), runtimePid: OWN }),
  row({ updatedAt: iso(-600), running: true }),
  row({ updatedAt: null }),
  row({ status: 'queued', stage: 'queued', updatedAt: iso(-300) }),
  row({ status: 'cancelling', stage: 'cancelling', updatedAt: iso(-300), runtimePid: DEAD }),
  row({ status: 'cancelled', stage: 'cancelled', updatedAt: iso(-300) }),
  row({ status: '', stage: 'streaming', updatedAt: iso(-300) }),
  row({ status: 'idle', stage: 'idle', awaitingUser: 'approval', runtimePid: DEAD }),
  row({ status: 'idle', stage: 'idle', awaitingUser: 'approval', runtimePid: OWN }),
  row({ status: 'running', awaitingUser: 'approval', runtimePid: DEAD, updatedAt: iso(-300) }),
  row({ status: 'failed', stage: 'failed', failureReason: 'process-restart', ownerSessionId: 'lead-a', finishedAt: iso(-60) }),
  row({ status: 'failed', stage: 'failed', failureReason: 'process-restart', ownerSessionId: 'lead-a', restartNotified: iso(-10) }),
  row({ status: 'failed', stage: 'failed', failureReason: 'process-restart', ownerSessionId: '' }),
  row({ status: 'failed', stage: 'failed', failureReason: 'stalled' }),
  row({ updatedAt: iso(-600), provider: 'openai-oauth', reapAt: iso(500), finishedAt: iso(-20) }),
  row({ updatedAt: iso(-600), provider: 'nowhere', finishedAt: null, reapAt: null }),
  row({ updatedAt: iso(-600), runtimePid: DEAD, provider: 'openai-oauth' }),
];

const CONFIGS = { none: {}, custom: { autoClear: { providerIdleMs: { anthropic: 120000, default: 240000 } } } };
const RUNNING = ['sess_1'];

const cases = [];
for (const [configName, config] of Object.entries(CONFIGS)) {
  for (const deadOnly of [false, true]) {
    const rows = clone(ROWS);
    const byKey = new Map(rows.map((r) => [workerRowKey(r), r]));
    const store = {
      readAll: () => [...byKey.values()],
      write: (fn) => fn(byKey),
      update: (fn) => fn(byKey),
    };
    const settlement = createRestartSettlement({
      store,
      cfgMod: { loadConfig: () => config },
      mgr: { isSessionTurnInFlight: (id) => RUNNING.includes(id) },
    });
    const changed = settlement.recoverStaleWorkerRows({ deadOnly });
    const after = clone([...byKey.values()]);
    const pending = clone(settlement.pendingRestartFailures()).map((r) => r.sessionId);
    const told = new Set(after.filter((r) => r.restartNotified).map((r) => r.sessionId));
    settlement.markRestartNotified(settlement.pendingRestartFailures());
    // The stamp is the wall clock, so only its presence is recorded.
    const stamped = clone([...byKey.values()]).filter((r) => r.restartNotified && !told.has(r.sessionId)).map((r) => r.sessionId);
    cases.push({ config: configName, deadOnly, changed, after, pending, stamped, pendingAfter: settlement.pendingRestartFailures().map((r) => r.sessionId) });
  }
}

writeFileSync(
  join(FIXTURES_ROOT, 'restart-settlement', 'golden.json'),
  `${JSON.stringify({ domain: 'restart-settlement', recorder: 'benchmarks/rust-core/recorders/record-restart-settlement.mjs', now: NOW, ownPid: OWN, deadPid: DEAD, running: RUNNING, rows: ROWS, configs: CONFIGS, cases }, null, 1)}\n`
);
console.log(`recorded ${cases.length} cases`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
