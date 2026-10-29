// Legacy Goal tasks move into the session's todo list, and leave the Goal
// record only once the real session store has committed that list.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-goal-adoption-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;

const { saveSessionAsync } = await import('../runtime/agent/orchestrator/session/store.mjs');
const { settleSessionSummaryIndex } = await import('../runtime/agent/orchestrator/session/store/listing.mjs');
const { createGoalRuntime } = await import('../runtime/agent/orchestrator/runtime-core/goal-runtime.mjs');
const { todoSnapshot } = await import('../runtime/agent/orchestrator/runtime-core/todo-list.mjs');
const { createGoalFacadeApi } = await import('./goal-facade-api.mjs');

const runtimes = [];
test.after(async () => {
  for (const runtime of runtimes) runtime.close();
  await settleSessionSummaryIndex();
  await (await import('../runtime/agent/orchestrator/session/store/lifecycle-barriers.mjs')).flushSessionCloseMetrics();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

const LONG_TASK = `Verify ${'every migrated record keeps its full wording '.repeat(7)}end`.trim();
let sequence = 0;

function fixture() {
  const sessionId = `sess_legacy_adoption_${++sequence}`;
  const dataDir = join(root, `goals-${sequence}`);
  mkdirSync(join(dataDir, 'goals'), { recursive: true });
  const at = Date.now();
  writeFileSync(
    join(dataDir, 'goals', `${sessionId}.json`),
    JSON.stringify({
      version: 1,
      goal: {
        id: 'goal_legacy',
        objective: 'Legacy work',
        status: 'active',
        timeMode: 'duration',
        timeLimitMs: 60 * 60_000,
        timeUsedMs: 0,
        createdAt: at,
        updatedAt: at,
        tasks: [
          { id: 'task_1', text: 'Shipped part', status: 'completed' },
          { id: 'task_2', text: 'Needs approval', status: 'awaiting_approval' },
          { id: 'task_3', text: LONG_TASK, status: 'pending' },
        ],
      },
    })
  );
  const load = () => {
    const runtime = createGoalRuntime({ dataDir });
    runtimes.push(runtime);
    return runtime;
  };
  const session = (generation = 1) => ({
    id: sessionId,
    owner: 'user',
    agent: 'lead',
    generation,
    createdAt: at,
    updatedAt: at,
    messages: [{ role: 'user', content: 'hello' }],
  });
  // As the runtime boot wires it (boot/apis.mjs).
  const outcomes = [];
  const facade = (live, runtime) =>
    createGoalFacadeApi({
      agentStatusState: () => null,
      createCurrentSession: async () => {},
      getSession: () => live,
      getSessionId: () => live.id,
      goalRuntime: runtime,
      persistSession: async (saved) => {
        const outcome = await saveSessionAsync(saved, { expectedGeneration: saved.generation });
        outcomes.push(outcome);
        return outcome;
      },
    });
  const disk = () => JSON.parse(readFileSync(join(root, 'sessions', `${sessionId}.json`), 'utf8'));
  return { sessionId, load, session, facade, disk, outcomes };
}

const contents = (session) => todoSnapshot(session)?.phases.flatMap((phase) => phase.tasks) || [];
const legacyTexts = (runtime, id) => runtime.legacyTasks(id).map((task) => task.text);

test('a committed save clears the legacy tasks; the reloaded list keeps them, long wording whole', async () => {
  const f = fixture();
  const live = f.session();
  await saveSessionAsync(live);
  const api = f.facade(live, f.load());
  api.goalStatus();
  await api.adoptLegacyGoalTasks();

  assert.deepEqual(f.outcomes, ['saved']);
  assert.deepEqual(f.load().legacyTasks(f.sessionId), []);
  assert.ok(LONG_TASK.length > 200);
  assert.deepEqual(contents(f.disk()), [
    { content: 'Shipped part', status: 'completed' },
    { content: 'Needs approval', status: 'blocked', blocker: 'awaiting user approval' },
    { content: LONG_TASK, status: 'in_progress' },
  ]);
});

test('a save dropped by a generation conflict keeps the legacy tasks; the retry adds no duplicates', async () => {
  const f = fixture();
  // Disk moved on to generation 2; this copy still adopts at generation 1.
  await saveSessionAsync(f.session(2));
  const stale = f.session(1);
  const runtime = f.load();
  const api = f.facade(stale, runtime);
  api.goalStatus();
  await api.adoptLegacyGoalTasks();
  // The store resolved without writing: the save was dropped, not failed.
  assert.deepEqual(f.outcomes, ['dropped']);
  assert.deepEqual(legacyTexts(f.load(), f.sessionId), ['Shipped part', 'Needs approval', LONG_TASK]);
  assert.deepEqual(contents(f.disk()), []);

  // The current copy adopts again on its next load: one item per task.
  const current = f.disk();
  const retry = f.facade(current, runtime);
  retry.goalContinuation();
  await retry.adoptLegacyGoalTasks();
  assert.deepEqual(f.load().legacyTasks(f.sessionId), []);
  const reloaded = f.disk();
  assert.equal(contents(reloaded).length, 3);
  f.facade(reloaded, f.load()).goalStatus();
  assert.equal(contents(reloaded).length, 3);
});
