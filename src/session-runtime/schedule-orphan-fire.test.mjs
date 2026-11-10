// A schedule whose owner bot is gone never fires: the scheduler's cron fire
// goes through the real run path and owner check, against the bot's files.
import '../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const dataDir = process.env.MIXDOG_DATA_DIR;
// The scheduler's lock and scratch dirs live in the runtime root: a test
// scheduler that starts must never meet the live app's.
process.env.MIXDOG_RUNTIME_ROOT = join(dataDir, 'runtime');
const stamps = [];
const stored = new Map();
const schedulesDb = await import('../runtime/channels/lib/schedules-db.mjs');
mock.module('../runtime/channels/lib/schedules-db.mjs', {
  namedExports: {
    ...schedulesDb,
    getSchedule: async (name) => stored.get(name) ?? null,
    claimScheduleRun: async (name) => stored.get(name) ?? null,
    markScheduleSkipped: async (name) => stamps.push(['skipped', name]),
    markScheduleFailure: async (name) => stamps.push(['failed', name]),
    markScheduleSuccess: async (name) => stamps.push(['succeeded', name]),
    setNextFire: async () => {},
    markFired: async (name) => stamps.push(['fired', name]),
    markDone: async (name) => stamps.push(['done', name]),
  },
});
const turns = [];
let onTurn = () => {};
mock.module('./routine-home-turn.mjs', {
  namedExports: {
    runRoutineTurn: async (request) => {
      turns.push(request);
      onTurn(request);
      return { sessionId: 'sess_home_lead', result: 'ran' };
    },
  },
});

const { Scheduler } = await import('../runtime/channels/lib/scheduler.mjs');
const { runScheduleSession } = await import('./schedule-session-run.mjs');
const { createWorkflowAgentsApi } = await import('./workflow-agents-api.mjs');
const { createWorkflowHelpers, createWorkflowRouteHelpers } = await import(
  '../runtime/agent/orchestrator/runtime-core/workflow.mjs'
);
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await import(
  '../runtime/shared/markdown-frontmatter.mjs'
);

test('a schedule whose owner bot was deleted is skipped as paused on every fire, never run anywhere', async () => {
  // Archived: the entry file moved aside under a tombstone (the user's own
  // "메일 정기 검토" state). Purged: nothing of the bot left at all.
  const archived = join(dataDir, 'agents', 'agent-a70d746b04');
  mkdirSync(archived, { recursive: true });
  writeFileSync(join(archived, '.deleted'), 'deleted\n');
  writeFileSync(join(archived, 'AGENT.md.archived'), '---\nname: clerk\n---\n\nReview mail.\n');
  for (const [name, owner] of [
    ['mail-review', 'agent-a70d746b04'],
    ['purged-owner', 'agent-0000000000'],
  ]) {
    const schedule = { name, whenCron: '0 */3 * * *', prompt: 'Review mail', ownerAgentId: owner };
    stored.set(name, { ...schedule, enabled: true, status: 'active' });
    const scheduler = Object.assign(Object.create(Scheduler.prototype), {
      schedules: [schedule],
      running: new Set(),
      renaming: new Set(),
      cronJobs: new Map(),
      lastFired: new Map(),
      promptsDir: join(dataDir, 'prompts'),
      notifyFailure() {},
      // As the channels worker wires it (worker-main.mjs).
      scheduleRunner: (row, opts) => runScheduleSession(row, opts),
    });
    await scheduler.onCronFire(schedule, new Date());
    assert.ok(schedule.lastSkippedAt, `${name}: the fire is recorded as skipped`);
  }
  assert.deepEqual(turns, [], 'no turn ran, in the owner bot’s chat or under Mixy');
  assert.deepEqual(stamps, [
    ['skipped', 'mail-review'],
    ['skipped', 'purged-owner'],
  ]);
});

test('a one-shot that came due while its bot was archived fires once the bot is restored, without a restart', async (t) => {
  turns.length = 0;
  stamps.length = 0;
  const id = 'courier';
  const dir = join(dataDir, 'agents', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENT.md'), `---\nname: ${id}\ndescription: Parcels\n---\n\nTrack parcels.\n`);
  writeFileSync(join(dir, 'agent.json'), `${JSON.stringify({ name: id, description: 'Parcels' })}\n`);
  const schedule = {
    name: 'parcel-check',
    whenAt: new Date(Date.now() - 60_000).toISOString(),
    prompt: 'Check the parcel',
    ownerAgentId: id,
  };
  stored.set(schedule.name, { ...schedule, enabled: true, status: 'active' });
  const scheduler = new Scheduler([{ ...schedule }]);
  scheduler.setScheduleRunner((row, opts) => runScheduleSession(row, opts));
  t.after(() => scheduler.stop());

  const config = { workflow: { active: 'default' }, default: 'workflow-lead', agents: {} };
  const { agentRouteFromConfig } = createWorkflowRouteHelpers({ findPreset: () => null });
  const api = createWorkflowAgentsApi({
    ...createWorkflowHelpers({
      rootDir: join(process.cwd(), 'src'),
      dataDir,
      readMarkdownDocument,
      normalizeAgentPermissionOrNone,
    }),
    getConfig: () => config,
    displayConfig: () => config,
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    resolveRoute: (_config, requested) => ({ ...requested }),
    agentRouteFromConfig,
    saveConfigAndAdopt: (value) => Object.assign(config, value),
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    refreshEmptySessionToolPolicy: async () => ({ appliedToCurrentSession: true }),
    invalidateContextStatusCache() {},
    // The channels worker's reload_config (boot/tools.mjs reloadChannelsSoon →
    // owned-runtime/config-reload.mjs): the stored rows, re-armed.
    reloadRoutines: () =>
      scheduler.reloadConfig(
        [...stored.values()].map(({ enabled, status, ...row }) => ({ ...row, enabled })),
        { restart: true }
      ),
  });

  await api.deleteAgentDefinition(id);
  // Its timer elapses while the bot is archived: paused, nothing left armed.
  await scheduler.fireOneShot(scheduler.schedules[0]);
  assert.deepEqual(turns, []);
  assert.equal(scheduler.oneShotTimers.size, 0);

  const fired = new Promise((resolve) => {
    onTurn = resolve;
  });
  await api.restoreAgentDefinition(id);
  let timer;
  const turn = await Promise.race([
    fired,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 3000);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(turn?.name, 'parcel-check', 'the restored bot’s overdue one-shot fires');
  assert.equal(turn.ownerAgentId, id);
});
