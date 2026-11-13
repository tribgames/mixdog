#!/usr/bin/env node
// What `agent cleanup` and `agent close` do since 6de9f07bc, on real Node (agent-tool/execute.mjs over the real close flow,
// close-flow.mjs, and the real background-task table): cleanup closes the caller's idle agents whose last result was
// delivered, drops the worker rows of deleted sessions and hides the idle agent sessions no row points to; a close names
// why it did not land and drops the row of a deleted session.
//
// `dispatch`: the scripted world of native/core/fixtures/agent/record-agent-tool.mjs (its fakes, its log), with what cleanup
// asks of the session manager (sessionGone, isSessionTurnInFlight, listSessions) answered from the world, unlogged. Per
// scenario the effect calls in order and the rendered answer. The two scenarios of that recording whose answer 6de9f07bc
// changed (`cleanup`, `close_that_fails_keeps_the_row`) are recorded here again, from this commit.
//
// `delivery`: `releaseIdle(row)` of the real close flow over jobs put on the real table and ended as the scenario says: the
// state it answers (`closed`: the result was delivered; `undelivered`).
//
//   node benchmarks/rust-core/recorders/record-agent-cleanup.mjs --tree <exact export of 0bf8fe045 with node_modules>
// Output: native/core/fixtures/agent-cleanup/cases.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = '0bf8fe0457fac66e5a51d319dad1fd3eee365bf6';
const recorder = 'benchmarks/rust-core/recorders/record-agent-cleanup.mjs';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
// The daemon's hidden set is a file of the data directory.
const dataDir = mkdtempSync(join(tmpdir(), 'agent-cleanup-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const load = (rel) => importFrom(tree, rel);
const { createAgentExecute } = await load('src/session-runtime/services/agent-tool/execute.mjs');
const { createCloseFlow } = await load('src/session-runtime/services/agent-tool/close-flow.mjs');
const { callerSessionForContext, terminalPidForContext, rowMatchesContext } = await load('src/session-runtime/services/agent-tool/helpers.mjs');
const tasksModule = await load('src/runtime/shared/background-tasks.mjs');
const hiddenModule = await load('src/runtime/shared/session-hidden.mjs');

const CTX = { callerSessionId: 'lead1', clientHostPid: 4242, cwd: '/work' };
const OWNED = { parentSessionId: 'lead1' };
const live = (id, agent = 'worker', cwd = '/work') => ({ id, agent, cwd, ...OWNED });
const idleRow = (tag, sessionId, extra = {}) => ({ tag, sessionId, status: 'idle', agent: 'worker', cwd: '/work', ...OWNED, ...extra });
const idleSession = (id, agentTag, extra = {}) => ({ id, agentTag, agent: 'worker', status: 'idle', ...OWNED, ...extra });

const scenarios = [
  { name: 'cleanup', args: { type: 'cleanup' }, world: { tags: { a: 's1', b: 's2' }, jobs: [{ task_id: 't1', status: 'running' }], workers: [{ tag: 'a' }] } },
  {
    // Of the caller's rows only the idle agent whose result was delivered closes: not the running one, not the one whose
    // job still runs, not the one with a turn in flight, not a cancelled one, and no other owner's.
    name: 'cleanup_closes_the_delivered_idle_agents',
    args: { type: 'cleanup' },
    world: {
      tags: { w1: 's1', w2: 's2', w3: 's3', w4: 's4', w6: 's6' },
      live: { s1: live('s1'), s2: live('s2'), s3: live('s3'), s4: live('s4'), s6: live('s6') },
      descendants: { s1: ['d1'] },
      closeOk: true,
      rows: [
        idleRow('w1', 's1'),
        idleRow('w2', 's2', { status: 'running' }),
        idleRow('w3', 's3'),
        { tag: 'w4', sessionId: 's4', stage: 'idle', agent: 'worker', cwd: '/work', ...OWNED },
        idleRow('w5', 's5', { parentSessionId: 'other' }),
        idleRow('w6', 's6', { stage: 'cancelled' }),
      ],
      inFlight: ['s4'],
      tasks: [{ task_id: 'task-run', sessionId: 's3', tag: 'w3' }],
    },
  },
  {
    // A row of any status whose session was deleted goes, with its tag and its jobs.
    name: 'cleanup_clears_the_rows_of_deleted_sessions',
    args: { type: 'cleanup' },
    world: {
      tags: { g1: 'g1s' },
      rows: [idleRow('g1', 'g1s', { status: 'running' }), idleRow('g2', 'g2s')],
      gone: ['g1s', 'g2s'],
      tasks: [{ task_id: 'task-G', sessionId: 'g1s', tag: 'g1' }],
    },
  },
  {
    name: 'cleanup_names_the_idle_agents_it_could_not_close',
    args: { type: 'cleanup' },
    world: { tags: { w1: 's1' }, live: { s1: live('s1') }, closeOk: false, rows: [idleRow('w1', 's1'), idleRow('w7', 's7')] },
  },
  {
    // Hidden: the caller's idle agent sessions no row and no tag points to, their result delivered (`l1`, and `l11`, which
    // has no status). Not hidden: another owner's, a running one, one with no tag, a Lead, one a row (of any owner) or a
    // tag points to, one hidden already, one with a turn in flight, one whose job still runs.
    name: 'cleanup_hides_the_idle_sessions_no_row_points_to',
    args: { type: 'cleanup' },
    world: {
      tags: { bound: 'l7' },
      rows: [idleRow('pointed', 'l6', { status: 'running', parentSessionId: 'other' })],
      sessions: [
        idleSession('l1', 'old'),
        idleSession('l2', 'foreign', { parentSessionId: 'other' }),
        idleSession('l3', 'busy', { status: 'running' }),
        idleSession('l4', ''),
        idleSession('l5', 'boss', { agent: 'Lead' }),
        idleSession('l6', 'pointed'),
        idleSession('l7', 'bound'),
        idleSession('l8', 'hid'),
        idleSession('l9', 'fly'),
        idleSession('l10', 'und'),
        { id: 'l11', agentTag: 'fresh', agent: 'worker', ...OWNED },
      ],
      hidden: ['l8'],
      inFlight: ['l9'],
      tasks: [{ task_id: 'task-und', sessionId: null, tag: 'und' }],
    },
  },
  {
    name: 'close_that_fails_keeps_the_row',
    args: { type: 'cancel', sessionId: 's1' },
    world: { tags: { w1: 's1' }, live: { s1: live('s1') }, closeOk: false },
  },
  {
    name: 'close_of_a_deleted_session_drops_its_row',
    args: { type: 'close', tag: 'w1', task_id: 'task-B' },
    world: { tags: { w1: 's1' }, live: { s1: live('s1') }, gone: ['s1'], closeOk: true, tasks: [{ task_id: 'task-B', sessionId: 's1', tag: 'w1' }] },
  },
  {
    name: 'close_of_a_deleted_session_by_its_id',
    args: { type: 'close', sessionId: 'sess_gone' },
    world: { live: { sess_gone: live('sess_gone') }, gone: ['sess_gone'], closeOk: true },
  },
  {
    // An untagged target that is not a session id is taken for the row's tag.
    name: 'close_of_a_deleted_session_by_a_bare_name',
    args: { type: 'close', sessionId: 'bare' },
    world: { live: { bare: live('bare') }, gone: ['bare'], closeOk: true },
  },
];

const scopeKey = (ctx) => ({ s: callerSessionForContext(ctx), p: terminalPidForContext(ctx) });
const jsonable = (v) => JSON.parse(JSON.stringify(v ?? null));
const forgetHidden = () => hiddenModule.forgetHidden(Object.keys(hiddenModule.daemonHiddenSessions()));

/** The fakes of record-agent-tool.mjs over `world`, logging into `log`. */
function collaborators(world, log) {
  const tags = new Map(Object.entries(world.tags || {}));
  const tagAgents = new Map((world.tagAgents || []).map((t) => [t, 'worker']));
  const liveSession = (id) => (id && world.live?.[id] ? world.live[id] : null);
  const mgr = {
    rehydrateAgentSessions: async () => log('rehydrate'),
    readSessionHandoff: async () => world.handoff ?? null,
    closeSession: async (id, reason, opts) => {
      log('closeSession', id, reason, opts);
      return world.closeOk === true;
    },
    descendantSessionIds: (id) => world.descendants?.[id] || [],
    // What cleanup asks of the session manager, answered from the world, unlogged.
    sessionGone: async (id) => (world.gone || []).includes(id),
    isSessionTurnInFlight: (id) => (world.inFlight || []).includes(id),
    listSessions: () => world.sessions || [],
  };
  const registry = {
    resolveTombstoneOwners: () => log('resolveTombstoneOwners'),
    refreshTagsFromSessions: ({ scanSessions, context }) => log('refreshTags', scanSessions, scopeKey(context)),
    wantsSessionScan: (args = {}) => args.recover === true || args.scanSessions === true || args.scan_sessions === true,
    resolveTag: (tag, context, opts = {}) => {
      log('resolveTag', tag, scopeKey(context), { scan: opts.scanSessions === true, traces: opts.excludeTerminalTraces === true });
      return tags.get(tag) || (liveSession(tag) ? tag : null);
    },
    getLiveSession: (id) => liveSession(id),
    tags,
    tagAgents,
    tagForSession: (id) => [...tags.entries()].find(([, sid]) => sid === id)?.[0] ?? null,
    unbindTag: (tag) => {
      log('unbindTag', tag);
      tags.delete(tag);
      tagAgents.delete(tag);
    },
    bindTag: (tag, session) => log('bindTag', tag, session.id),
    forgetTerminalSession: (tag, sessionId) => log('forgetTerminalSession', tag, sessionId),
    removeWorkerRow: (row) => log('removeWorkerRow', row.sessionId),
    markReleased: (ids) => log('markReleased', ids),
    readWorkerRows: (context) => (world.rows || []).filter((row) => rowMatchesContext(row, context)),
    readAllTagTombstones: () => [],
    tagTombstoneForTag: () => null,
    consumeTagTombstone: (row) => log('consumeTagTombstone', row.tag, row.sessionId),
    lastTagSession: () => null,
    resumableTagSession: async () => null,
  };
  const views = {
    getJobOrWorker: () => structuredClone(world.job),
    renderJob: (job) => job.view,
    list: () => world.workers || [],
    listJobs: () => world.jobs || [],
  };
  return { mgr, registry, views };
}

async function runScenario(scenario) {
  const world = structuredClone(scenario.world || {});
  const trace = [];
  let finished = false;
  const log = (...entry) => {
    if (!finished) trace.push(jsonable(entry));
  };
  const { mgr, registry, views } = collaborators(world, log);
  const unused = (name) => () => {
    throw new Error(`${name} is not part of a close or a cleanup`);
  };
  const closeFlow = createCloseFlow({ mgr, registry, views });
  const execute = createAgentExecute({
    mgr,
    defaultCwd: '/work',
    awaitKeychainPrewarm: async () => {},
    registry,
    views,
    spawnFlow: { startDeferredSpawnJob: unused('startDeferredSpawnJob') },
    sendFlow: { prepareSend: unused('prepareSend'), adoptCaller: unused('adoptCaller'), dispatchToExistingSession: unused('dispatchToExistingSession') },
    closeFlow,
    terminalTrace: { hasTerminalTrace: () => false, reapTerminalTraceForTag: unused('reapTerminalTraceForTag') },
    listProviderModels: null,
  });
  const registered = [];
  for (const task of world.tasks || []) {
    registered.push(
      tasksModule.registerBackgroundTask({
        taskId: task.task_id,
        surface: 'agent',
        context: CTX,
        meta: { ...(task.sessionId ? { sessionId: task.sessionId } : {}), ...(task.tag ? { tag: task.tag } : {}) },
        cancel: () => log('cancelTask', task.task_id),
      })
    );
  }
  // The daemon's hidden set is process-wide: each scenario starts from its own and leaves none.
  if (world.hidden?.length) await hiddenModule.hideInDaemon(world.hidden);
  const result = await execute(structuredClone(scenario.args), { ...CTX });
  finished = true;
  await forgetHidden();
  // The task table is process-wide: nothing of this scenario stays on it.
  for (const task of registered) tasksModule.reconcileBackgroundTask(task.taskId, { status: 'cancelled' });
  tasksModule.cleanupBackgroundTasks({ surface: 'agent', force: true });
  return { trace, result };
}

// ---- delivery --------------------------------------------------------------------------------------------------------

const job = (id, session, tag, owner = 'lead1') => ({ op: 'register', id, session, tag, owner });
const ROW = { tag: 'w1', sessionId: 's1' };
const delivery = [
  { name: 'no_job_reads_as_delivered', ops: [] },
  { name: 'a_running_job_is_not_delivered', ops: [job('d1', 's1', 'w1')] },
  { name: 'a_completion_nobody_was_told_is_not_delivered', ops: [job('d1', 's1', 'w1'), { op: 'complete', id: 'd1' }] },
  { name: 'a_completion_that_was_read_is_delivered', ops: [job('d1', 's1', 'w1'), { op: 'complete', id: 'd1' }, { op: 'acknowledge', id: 'd1' }] },
  { name: 'a_cancelled_job_is_delivered', ops: [job('d1', 's1', 'w1'), { op: 'cancel', id: 'd1' }] },
  { name: 'the_newest_job_decides', ops: [job('d1', 's1', 'w1'), { op: 'cancel', id: 'd1' }, job('d2', 's1', 'w1')] },
  { name: 'the_newest_job_decides_when_it_was_read', ops: [job('d1', 's1', 'w1'), job('d2', 's1', 'w1'), { op: 'complete', id: 'd2' }, { op: 'acknowledge', id: 'd2' }] },
  { name: 'a_job_of_the_tag_on_another_session_counts', ops: [job('d1', 'earlier', 'w1')] },
  { name: 'a_job_of_the_session_under_another_tag_counts', ops: [job('d1', 's1', 'other')] },
  { name: 'a_job_with_neither_does_not_count', ops: [job('d1', 's9', 'w9')] },
  { name: 'another_owners_job_is_outside_the_scope', ops: [job('d1', 's1', 'w1', 'lead2')] },
  { name: 'a_job_pruned_undelivered_is_lost', ops: [job('d1', 's1', 'w1'), { op: 'complete', id: 'd1' }, { op: 'evict', owner: 'lead1' }] },
  { name: 'a_running_job_pruned_is_lost', ops: [job('d1', 's1', 'w1'), { op: 'evict', owner: 'lead1' }] },
  { name: 'a_job_pruned_delivered_is_not_lost', ops: [job('d1', 's1', 'w1'), { op: 'cancel', id: 'd1' }, { op: 'evict', owner: 'lead1' }] },
  {
    name: 'a_later_delivered_prune_supersedes_a_lost_one',
    ops: [job('d1', 's1', 'w1'), { op: 'complete', id: 'd1' }, { op: 'evict', owner: 'lead1' }, job('d2', 's1', 'w1'), { op: 'cancel', id: 'd2' }, { op: 'evict', owner: 'lead1' }],
  },
  { name: 'a_lost_tag_holds_the_owners_next_session_of_it', ops: [job('d1', 'earlier', 'w1'), { op: 'complete', id: 'd1' }, { op: 'evict', owner: 'lead1' }] },
  { name: 'a_lost_tag_of_another_owner_does_not_hold', ops: [job('d1', 'earlier', 'w1', 'lead2'), { op: 'complete', id: 'd1' }, { op: 'evict', owner: 'lead2' }] },
  {
    name: 'a_live_job_decides_before_a_lost_one',
    ops: [job('d1', 's1', 'w1'), { op: 'complete', id: 'd1' }, { op: 'evict', owner: 'lead1' }, job('d2', 's1', 'w1'), { op: 'cancel', id: 'd2' }],
  },
];

async function runDelivery(scenario) {
  const world = { live: { s1: live('s1') }, closeOk: true };
  const { mgr, registry, views } = collaborators(world, () => {});
  // The close flow hears the table's prunes from its creation on.
  const closeFlow = createCloseFlow({ mgr, registry, views });
  for (const step of scenario.ops) {
    const options = { surface: 'agent' };
    if (step.op === 'register') {
      tasksModule.registerBackgroundTask({ taskId: step.id, surface: 'agent', context: { callerSessionId: step.owner }, meta: { sessionId: step.session, tag: step.tag } });
    } else if (step.op === 'complete') tasksModule.completeBackgroundTask(step.id, { status: 'completed', result: 'the result' });
    else if (step.op === 'acknowledge') tasksModule.acknowledgeBackgroundTaskCompletion(step.id, options);
    else if (step.op === 'cancel') tasksModule.cancelBackgroundTask(step.id, 'cancelled by the recorder');
    else if (step.op === 'evict') tasksModule.cleanupBackgroundTasks({ surface: 'agent', context: { callerSessionId: step.owner }, force: true });
    else throw new Error(`unknown step ${step.op}`);
  }
  const { state } = await closeFlow.releaseIdle({ ...ROW, ...OWNED }, { callerSessionId: 'lead1' });
  await forgetHidden();
  tasksModule.cleanupBackgroundTasks({ surface: 'agent', force: true });
  return state;
}

const dispatch = [];
for (const scenario of scenarios) {
  const { trace, result } = await runScenario(scenario);
  dispatch.push({ name: scenario.name, args: scenario.args, context: CTX, world: scenario.world || {}, trace, result });
}
const delivered = [];
for (const scenario of delivery) delivered.push({ ...scenario, row: ROW, owner: 'lead1', state: await runDelivery(scenario) });

const finalOut = join(FIXTURES_ROOT, 'agent-cleanup');
const stage = stageSet(finalOut);
writeJson(join(stage, 'cases.json'), {
  note: 'agent cleanup and close of real Node since 6de9f07bc: the dispatch over a scripted world, and whether an idle agent reads as delivered',
  dispatch,
  delivery: delivered,
});
writeSetManifest(stage, {
  set: 'agent-cleanup',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: dispatch.length + delivered.length,
    syntheticInputs: [
      'dispatch: the registry, views and session manager are the scripted fakes of native/core/fixtures/agent/record-agent-tool.mjs; sessionGone, isSessionTurnInFlight and listSessions answer from the world and log nothing; every job of a world is running',
      'delivery: the jobs are put on the real table and ended by the table\'s own calls; no notifier is attached, so a completion goes out to nobody',
    ],
    keptWhole: 'dispatch: per scenario its arguments, context and world, the effect calls in order and the rendered answer; delivery: per scenario its steps and the state releaseIdle answered',
    exclusions: {
      'dispatch: the daemon\'s hidden set': 'Node hides a session in its own hidden set (runtime/shared/session-hidden.mjs), which the recorder seeds from the world\'s `hidden` and which is not one of the logged collaborators; the core hides by the session header\'s archivedAt, and a replay seeds its fake of that from the same list. Which sessions a cleanup hid is compared through the count in the answer',
      'delivery: the close that follows': 'a delivered agent is then closed through the scripted fakes; the replay compares only whether the table reads the agent as delivered (`closed`) or not (`undelivered`)',
    },
  },
});
commitStage(stage, finalOut);
rmSync(dataDir, { recursive: true, force: true });
for (const c of dispatch) console.log(c.name.padEnd(56), JSON.stringify(c.result).slice(0, 110));
for (const c of delivered) console.log(c.name.padEnd(56), c.state);
process.exit(0);
