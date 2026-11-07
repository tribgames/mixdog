#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the daemon's boot coordinator around Goal recovery
// (`daemon-boot-coordinator.mjs`, `recoverActiveGoals` at :59 and `startQuotaResume` after it), for the
// Rust daemon's boot step: the real coordinator over the real `createGoalRecovery` and the real stored-Goal
// readers, on a data dir holding active, paused and expired Goals. `materializeSession` is the only
// stand-in (the full session service is not this fixture's subject): it records the session it is asked for.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-boot-recovery.mjs --tree <tree>
// Output: native/core/fixtures/boot-recovery/golden.json
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createDaemonBootCoordinator } = await importFrom(tree, 'src/standalone/daemon-boot-coordinator.mjs');
const { createGoalRecovery } = await importFrom(tree, 'src/standalone/session-service/session-calls/goal-recovery.mjs');
const { DEFAULT_COMPLETED_GOAL_TTL_MS, listStoredActiveGoalSessionIds, readStoredGoalSnapshot } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/runtime-core/goal-runtime.mjs'
);

const CLOCK = 2_200_000_000_000;
const now = () => CLOCK;

/** The Goal file the runtime stores: `status`, and a `complete` Goal whose TTL ran out when `expired`. */
const goalFile = (sessionId, status, expired = false) => ({
  version: 1,
  goal: {
    id: `goal-${status}-${sessionId}`,
    sessionId,
    objective: `Keep ${status} Goal`,
    title: `${status} Goal`,
    status,
    blocker: '',
    failureReason: '',
    failureCount: 0,
    timeLimitMs: 0,
    timeUsedMs: 5_000,
    createdAt: CLOCK - 10_000,
    updatedAt: CLOCK - 5_000,
    lastStartedAt: status === 'active' ? CLOCK - 5_000 : null,
    completedAt: status === 'complete' ? (expired ? CLOCK - DEFAULT_COMPLETED_GOAL_TTL_MS : CLOCK - 5_000) : null,
    archivedAt: null,
  },
});

const MIXED = {
  sess_boot_active: goalFile('sess_boot_active', 'active'),
  sess_boot_paused: goalFile('sess_boot_paused', 'paused'),
  sess_boot_expired: goalFile('sess_boot_expired', 'complete', true),
};
const WITH_BROKEN = { ...MIXED, sess_boot_broken: goalFile('sess_boot_broken', 'active') };

const cases = [];
/**
 * One boot: the goal files written, what is injected, the triggers fired in order; the answer is
 * everything the lane did, in order.
 */
async function bootCase(name, note, { files = MIXED, inject = {}, triggers }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'boot-recovery-'));
  const goals = join(dataDir, 'goals');
  mkdirSync(goals, { recursive: true });
  for (const [id, body] of Object.entries(files)) writeFileSync(join(goals, `${id}.json`), JSON.stringify(body));
  const events = [];
  const logs = [];
  const scheduled = [];
  const recovery = createGoalRecovery({
    log: (line) => logs.push(line),
    readStoredGoal: async (sessionId) => readStoredGoalSnapshot({ dataDir, sessionId, now }),
    listStoredActiveGoalSessionIds: async () => {
      if (inject.list) throw new Error(inject.list);
      return listStoredActiveGoalSessionIds({ dataDir, now });
    },
    materializeSession: async (sessionId) => {
      events.push(`materialize ${sessionId}`);
      if ((inject.materializeFails ?? []).includes(sessionId)) throw new Error('cannot materialize');
    },
  });
  const coordinator = createDaemonBootCoordinator({
    schedule: (task) => scheduled.push(task),
    prewarmKeychain: async () => {
      events.push('keychain');
    },
    recoverActiveGoals: async () => {
      events.push('recover');
      if (inject.recover) throw new Error(inject.recover);
      return recovery();
    },
    startQuotaResume: () => {
      events.push('quota-start');
      if (inject.quota) throw new Error(inject.quota);
    },
    log: (line) => logs.push(line),
  });
  const queued = [];
  for (const trigger of triggers) {
    if (trigger.registered) coordinator.notifyClientRegistered({ clientKind: trigger.registered });
    else coordinator.notifyDesktopReady();
    queued.push(scheduled.length);
    while (scheduled.length) scheduled.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  cases.push({
    name,
    note,
    files,
    inject,
    triggers,
    queuedAfterEach: queued,
    events,
    logs,
    goalsLeft: readdirSync(goals).sort(),
    status: coordinator.status,
  });
  rmSync(dataDir, { recursive: true, force: true });
}

await bootCase('session-client', 'a session client registers: the lane recovers the active Goal only, then starts the quota clock', {
  triggers: [{ registered: 'session' }],
});
await bootCase('desktop-registration-only', 'a desktop registers: nothing recovers until it is ready', {
  triggers: [{ registered: 'desktop' }],
});
await bootCase('desktop-ready', 'a desktop registers and is ready: the lane runs after the keychain', {
  triggers: [{ registered: 'desktop' }, { ready: true }],
});
await bootCase('once', 'every later client and ready signal joins the lane that began', {
  triggers: [{ registered: 'session' }, { registered: 'session' }, { ready: true }, { registered: 'desktop' }],
});
await bootCase('nothing-stored', 'no Goal is stored', { files: {}, triggers: [{ registered: 'session' }] });
await bootCase('materialize-fails', 'one active Goal cannot be materialized: the others still are', {
  files: WITH_BROKEN,
  inject: { materializeFails: ['sess_boot_broken'] },
  triggers: [{ registered: 'session' }],
});
await bootCase('discovery-fails', 'the stored Goals cannot be listed', {
  inject: { list: 'boom' },
  triggers: [{ registered: 'session' }],
});
await bootCase('recovery-rejects', 'recovery itself rejects: the lane ends and the quota clock is not started', {
  inject: { recover: 'boom' },
  triggers: [{ registered: 'session' }],
});
await bootCase('quota-start-fails', 'the quota clock fails to start: logged, never fatal', {
  inject: { quota: 'boom' },
  triggers: [{ registered: 'session' }],
});

const rel = 'benchmarks/rust-core/recorders/record-boot-recovery.mjs';
const setDir = join(FIXTURES_ROOT, 'boot-recovery');
writeJson(join(setDir, 'golden.json'), { domain: 'boot-recovery', recorder: rel, clock: CLOCK, cases });
const command = `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${rel} --tree <tree>`;
writeSetManifest(setDir, { set: 'boot-recovery', recorder: rel, command });
console.log(`recorded ${cases.length} boot cases`);
process.exit(0);
