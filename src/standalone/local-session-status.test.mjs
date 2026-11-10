// The daemon's status scheduler runs a session's runtime pass (HEAD retarget,
// route/context/agent publication, delegated-approval adoption) on events, not
// on a per-session 2 s interval. Everything from createLocalSessionRuntime
// down is real except the session runtime, a stand-in object.
import '../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  delegateApproval,
  withdrawDelegatedApproval,
} from '../runtime/shared/delegated-approval-host.mjs';
import { readGitHead } from '../runtime/shared/worktrees/git-head.mjs';
import { bumpConfigInputEpoch } from '../runtime/shared/config-epoch.mjs';
import { createGoalStorage } from '../runtime/agent/orchestrator/runtime-core/goal-storage.mjs';
import { tempDirFor } from '../../scripts/lib/scoped-temp.mjs';
import { createContextState } from '../tui/session/context-state.mjs';
import { createSessionDraftStore } from '../tui/session/draft-store.mjs';
import {
  createLocalSessionRuntime,
  createRuntimePulse,
  createSessionStatusWatch,
  setSessionRuntimeImporterForTest,
} from './local-session-runtime.mjs';
import { createSessionStatusScheduler, sessionStatusScheduler } from './session-status-scheduler.mjs';

// Within the 250 ms target with room for a loaded CI machine.
const PROMPT_MS = 400;
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRuntime(id, cwd) {
  const agentListeners = new Set();
  let agentRead;
  const firstAgentRead = new Promise((resolve) => {
    agentRead = resolve;
  });
  return {
    id,
    session: { id },
    cwd,
    model: 'model-a',
    provider: 'provider-a',
    effort: 'medium',
    effortOptions: ['low', 'medium', 'high'],
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    // A ready agent service answers with its scope (null only before the keychain prewarm).
    agents: { agentWorkers: [], agentJobs: [], agentScope: { sessionId: id } },
    contextStatus: () => null,
    firstAgentRead,
    agentStatus() {
      agentRead();
      return this.agents;
    },
    getLiveWorkspace() {
      return { cwd: this.cwd, branch: readGitHead(this.cwd)?.branch ?? null };
    },
    onAgentStatusChange(listener) {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
    // An agent job starting: the agent service's status event.
    startAgentJob(job) {
      this.agents = { ...this.agents, agentJobs: [...this.agents.agentJobs, job] };
      for (const listener of agentListeners) listener();
    },
    async close() {},
  };
}

async function openSession(t, runtime) {
  setSessionRuntimeImporterForTest(async () => ({ createMixdogSessionRuntime: async () => runtime }));
  const api = await createLocalSessionRuntime({ cwd: runtime.cwd });
  t.after(async () => {
    await api.dispose();
    setSessionRuntimeImporterForTest(null);
  });
  return api;
}

/** Resolves with the elapsed ms once a published frame satisfies `predicate`. */
function published(api, predicate, ms = PROMPT_MS) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!predicate(api.getState())) return false;
      clearTimeout(timer);
      off();
      resolve(performance.now() - startedAt);
      return true;
    };
    const off = api.subscribe(check);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`not published within ${ms} ms`));
    }, ms);
    check();
  });
}

/** `promise`, holding the event loop open (the scheduler's timers do not) for at most `ms`. */
function within(promise, ms = 1000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function repo(root, name, branch) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}

test('a delegated approval waiting before the session loaded surfaces as it loads', async (t) => {
  const request = { id: 'appr-load', kind: 'tool', toolName: 'Bash', sessionId: 'sess-worker' };
  delegateApproval({ id: 'appr-load', sessionId: 'sess-load', request, answer: () => true });
  t.after(() => withdrawDelegatedApproval('appr-load'));
  const api = await openSession(t, fakeRuntime('sess-load', tempDirFor(t, 'status-load')));
  await published(api, (state) => state.toolApproval?.id === 'appr-load');
  // The owner settling it withdraws the copy: no pass is involved.
  withdrawDelegatedApproval('appr-load', { approved: true, device: 'phone' });
  await published(api, (state) => state.toolApproval === null, 100);
});

test('a session that binds another id adopts the approvals waiting for that id', async (t) => {
  const runtime = fakeRuntime('sess-before', tempDirFor(t, 'status-rebind'));
  const api = await openSession(t, runtime);
  await tick(50);
  const request = { id: 'appr-rebind', kind: 'tool', toolName: 'Bash', sessionId: 'sess-worker' };
  delegateApproval({ id: 'appr-rebind', sessionId: 'sess-after', request, answer: () => true });
  t.after(() => withdrawDelegatedApproval('appr-rebind'));
  await tick(50);
  assert.equal(api.getState().toolApproval ?? null, null, 'not this session yet');
  runtime.id = 'sess-after';
  runtime.session = { id: 'sess-after' };
  runtime.startAgentJob({ task_id: 'job-1', status: 'running', finishedAt: null });
  await published(api, (state) => state.sessionId === 'sess-after' && state.toolApproval?.id === 'appr-rebind');
});

test('a moved session folder retargets its HEAD watch on the next event', async (t) => {
  const root = tempDirFor(t, 'status-retarget');
  const first = repo(root, 'first', 'one');
  const second = repo(root, 'second', 'two');
  const runtime = fakeRuntime('sess-retarget', first);
  const api = await openSession(t, runtime);
  await published(api, (state) => state.workspace?.branch === 'one');
  runtime.cwd = second;
  runtime.startAgentJob({ task_id: 'job-2', status: 'running', finishedAt: null });
  await published(api, (state) => state.workspace?.branch === 'two');
  await tick(100);
  // Only the retargeted watch can carry this: nothing else marks the session.
  writeFileSync(join(second, '.git', 'HEAD'), 'ref: refs/heads/three\n');
  await published(api, (state) => state.workspace?.branch === 'three', 1500);
});

test('an idle session publishes nothing and runs no pass', async (t) => {
  const api = await openSession(t, fakeRuntime('sess-idle', tempDirFor(t, 'status-idle')));
  await tick(300);
  const before = sessionStatusScheduler().counters().recomputes;
  let frames = 0;
  const off = api.subscribe(() => frames++);
  await tick(2500);
  off();
  assert.equal(frames, 0);
  assert.equal(sessionStatusScheduler().counters().recomputes, before);
});

// The pass a scheduler runs is the pulse the 2 s interval ran: for the same
// inputs and the same trigger points, the published snapshots are equal frame
// by frame.
function pulseHarness(withScheduler, { recompute = null } = {}) {
  const runtime = {
    id: 'sess-eq',
    session: { todo: null },
    model: 'model-a',
    provider: 'provider-a',
    effort: 'medium',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    cwd: '/work',
    context: { lastApiRequestTokens: 1000, contextWindow: 180_000, compaction: { boundaryTokens: 150_000 } },
    agents: { agentWorkers: [], agentJobs: [] },
    workspace: null,
    contextStatus() {
      return this.context;
    },
    agentStatus() {
      return { ...this.agents };
    },
    getLiveWorkspace() {
      return this.workspace;
    },
  };
  const draft = { state: null };
  const flags = { disposed: false, pendingSessionReset: false };
  const context = createContextState({
    runtime,
    getState: () => draft.state,
    updateState: (patch) => {
      draft.state = { ...draft.state, ...patch };
    },
    getPendingSessionReset: () => false,
    getVisibleGoal: () => null,
  });
  draft.state = { items: [], structureRevision: 0, busy: false, stats: { turns: 0 }, ...context.baseRouteState() };
  let frames = 0;
  const listeners = new Set([() => frames++]);
  const store = createSessionDraftStore({ draft, listeners, isDisposed: () => false, onBusyReleased() {} });
  let clock = 0;
  const pending = [];
  const timers = {
    setTimeout(fn, ms) {
      const task = { at: clock + ms, fn };
      pending.push(task);
      return task;
    },
    clearTimeout(task) {
      if (pending.includes(task)) pending.splice(pending.indexOf(task), 1);
    },
  };
  const watch = createSessionStatusWatch({ set: store.set, getState: store.getState, isDisposed: () => false });
  const pulse = createRuntimePulse({
    flags,
    getState: store.getState,
    getPublishedState: store.getPublishedState,
    set: store.set,
    emit: store.emit,
    routeState: context.routeState,
    agentStatusState: () => context.agentStatusState({ force: true }),
    syncContextStats: context.syncContextStats,
    liveWorkspace: () => runtime.getLiveWorkspace(),
  });
  const scheduler = createSessionStatusScheduler({ now: () => clock, timers });
  if (withScheduler) watch.start(scheduler, recompute ? () => recompute(pulse, watch) : pulse);
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = pending.filter((task) => task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      pending.splice(pending.indexOf(due), 1);
      clock = Math.max(clock, due.at);
      due.fn();
    }
    clock = end;
    store.flushEmit();
  };
  const trigger = () => {
    if (withScheduler) {
      watch.markDirty();
      advance(1000);
    } else {
      pulse();
    }
    store.flushEmit();
  };
  return { runtime, store, watch, listeners, scheduler, advance, trigger, frames: () => frames };
}

test('scheduled passes publish the same frames as the interval pulse for the same inputs', () => {
  const interval = pulseHarness(false);
  const scheduled = pulseHarness(true);
  const steps = [
    () => {},
    (runtime) => {
      runtime.model = 'model-b';
    },
    (runtime) => {
      runtime.context = { ...runtime.context, lastApiRequestTokens: 4200 };
    },
    (runtime) => {
      runtime.agents = { agentWorkers: [{ id: 'w1', status: 'running' }], agentJobs: [] };
    },
    (runtime) => {
      runtime.context = { ...runtime.context, contextWindow: 190_000 };
    },
    (runtime) => {
      runtime.turnEffort = 'low';
      runtime.workspace = { cwd: '/work', branch: 'main' };
    },
    () => {},
    () => {},
  ];
  for (const [index, step] of steps.entries()) {
    step(interval.runtime);
    step(scheduled.runtime);
    interval.trigger();
    scheduled.trigger();
    assert.deepEqual(scheduled.store.getPublishedState(), interval.store.getPublishedState(), `step ${index}`);
    assert.equal(scheduled.frames(), interval.frames(), `frames after step ${index}`);
  }
});

test('a change made synchronously inside a pass, after it read that input, is not lost', () => {
  const h = pulseHarness(true);
  h.advance(1000);
  const read = h.runtime.agentStatus.bind(h.runtime);
  let reacted = false;
  // The pass reads the route, then agent status; reading status runs a
  // collaborator (an agent status listener) that moves the route and
  // publishes what it did — after this pass already read the route.
  h.runtime.agentStatus = () => {
    if (!reacted) {
      reacted = true;
      h.runtime.model = 'model-from-inside';
      h.watch.set({ agentJobs: [{ task_id: 'job-inner', finishedAt: 'done' }] });
    }
    return read();
  };
  h.watch.markDirty();
  h.advance(250);
  assert.equal(reacted, true, 'the collaborator ran inside the pass');
  h.advance(250);
  assert.equal(h.store.getPublishedState().model, 'model-from-inside');
});

test("the stream's own presentation marks nothing; a stage, usage or turn change marks", () => {
  const h = pulseHarness(true);
  h.watch.set({ busy: true, spinner: { mode: 'thinking', responseLength: 0 } });
  h.advance(1000);
  const passes = () => h.scheduler.counters().recomputes;
  const settled = passes();
  for (let i = 1; i <= 20; i += 1) {
    h.watch.set({ streamingPartial: `partial ${i}` });
    h.watch.set({ streamingTail: { id: 'a', text: `line ${i}` } });
    h.watch.set({ thinking: `thought ${i}` });
    h.watch.set({ spinner: { mode: 'thinking', responseLength: i } });
    h.advance(50);
  }
  h.advance(1000);
  assert.equal(passes(), settled, 'streaming deltas run no pass');
  h.watch.set({ spinner: { mode: 'responding', responseLength: 21 } });
  h.advance(300);
  assert.equal(passes(), settled + 1, 'a stage change runs one');
  h.watch.set({ stats: { turns: 1 } });
  h.advance(300);
  assert.equal(passes(), settled + 2, "a step's usage runs one");
  h.watch.set({ busy: false, spinner: null });
  h.advance(300);
  assert.equal(passes(), settled + 3, 'the turn ending runs one');
});

test("another process rewriting the session's Goal record is published at once", async (t) => {
  const root = tempDirFor(t, 'status-goal');
  const pathFor = (id) => join(root, `${id}.json`);
  const writeGoal = (id, goal) => writeFileSync(pathFor(id), JSON.stringify({ version: 1, goal }));
  const storage = createGoalStorage({ pathFor, normalizeGoal: (goal) => goal, now: () => Date.now() });
  t.after(() => storage.close());
  const runtime = fakeRuntime('sess_goal_ext', tempDirFor(t, 'status-goal-cwd'));
  writeGoal(runtime.id, { id: 'g1', objective: 'first objective', status: 'paused' });
  runtime.goalStatus = () => storage.read(runtime.id).goal;
  const api = await openSession(t, runtime);
  await published(api, (state) => state.goal?.objective === 'first objective');
  await tick(100);
  writeGoal(runtime.id, { id: 'g1', objective: 'edited elsewhere', status: 'paused' });
  await published(api, (state) => state.goal?.objective === 'edited elsewhere');
});

test("this process's own Goal write reads back unchanged: no frame", async (t) => {
  const root = tempDirFor(t, 'status-goal-own');
  const pathFor = (id) => join(root, `${id}.json`);
  const storage = createGoalStorage({ pathFor, normalizeGoal: (goal) => goal, now: () => Date.now() });
  t.after(() => storage.close());
  const runtime = fakeRuntime('sess_goal_own', tempDirFor(t, 'status-goal-own-cwd'));
  const record = { version: 1, goal: { id: 'g1', objective: 'mine', status: 'paused' } };
  writeFileSync(pathFor(runtime.id), JSON.stringify(record));
  runtime.goalStatus = () => storage.read(runtime.id).goal;
  const api = await openSession(t, runtime);
  await published(api, (state) => state.goal?.objective === 'mine');
  await tick(300);
  let frames = 0;
  const off = api.subscribe(() => frames++);
  // A heartbeat-like rewrite of the same record: its watch events re-read it.
  await storage.write(runtime.id, record);
  await tick(600);
  off();
  assert.equal(frames, 0, 'an unchanged re-read publishes nothing');
  // The watch is still live: a real change after it is published.
  writeFileSync(pathFor(runtime.id), JSON.stringify({ version: 1, goal: { ...record.goal, objective: 'next' } }));
  await published(api, (state) => state.goal?.objective === 'next');
});

test('a mark right after a pass is answered with agent status read after the event', async (t) => {
  const runtime = fakeRuntime('sess-fresh-status', tempDirFor(t, 'status-fresh'));
  const api = await openSession(t, runtime);
  // Right after the registration pass read agent status (and filled its 250 ms cache) ...
  await within(runtime.firstAgentRead);
  // ... agent work changes and an event marks the session (the next pass is
  // one 200 ms interval out, inside that cache's lifetime).
  runtime.agents = { ...runtime.agents, agentJobs: [{ task_id: 'job-late', status: 'running', finishedAt: null }] };
  bumpConfigInputEpoch();
  await published(api, (state) => state.agentJobs?.[0]?.task_id === 'job-late');
});

test('a config-input epoch bump (a credential or account write) republishes every session', async (t) => {
  const runtime = fakeRuntime('sess-epoch', tempDirFor(t, 'status-epoch'));
  const api = await openSession(t, runtime);
  await tick(300);
  // rt.config was re-adopted after the credential change: no event of its own.
  runtime.model = 'model-after-credentials';
  bumpConfigInputEpoch();
  await published(api, (state) => state.model === 'model-after-credentials');
});
