// A bot's `session send` into a task session it created hands that session new
// work from the sending conversation: it is a schedule/webhook run's as that
// sender is (human-gate/delegation.mjs rebindDelegation), whichever it was
// created as. A task session is never a bot: an ordinary coding Lead session.
// A send into a session that is another's keeps that session's own status.
// Isolate Mixdog user data in a temp dir before any module under test loads.
import '../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { setLiveSession } from '../runtime/agent/orchestrator/session/store.mjs';
import { loadSession } from '../runtime/agent/orchestrator/session/store/load-session.mjs';
import { runtimeState } from '../runtime/agent/orchestrator/session/manager/runtime-state.mjs';
import { sessionOriginFields } from '../runtime/agent/orchestrator/session/manager/session-record.mjs';
import { createAgentTaskSessions } from '../session-runtime/agent-task-sessions.mjs';
import { markUnattendedRun, unattendedRunOf } from '../session-runtime/held-requests.mjs';
import { createSessionControl } from './daemon-session-control.mjs';

// A re-bound record is saved: into this test's own store, never the user's.
const dataRoot = mkdtempSync(join(tmpdir(), 'session-control-driver-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const HOME = 'sess_home_a';

/** A task session of bot `a`, created as the real manager records it. */
function taskSession(id, { run } = {}) {
  const unmark = run ? markUnattendedRun(HOME, { kind: 'schedule', agentId: 'a', name: 'Daily' }) : () => {};
  const record = {
    id,
    owner: 'cli',
    agent: 'lead',
    taskOrigin: { agentId: 'a', sessionId: HOME, requestId: `atask_${id}`, title: 'Report', notify: true },
  };
  const origin = sessionOriginFields(record, {
    profile: null,
    presetObj: null,
    providerCacheOpts: null,
    surface: { toolPermission: null, hasCallerAllow: false },
  });
  setLiveSession({
    ...record,
    ...(origin.delegation ? { delegation: origin.delegation } : {}),
    ...(origin.run ? { run: origin.run } : {}),
    createdAt: Date.now(),
  });
  unmark();
  return id;
}

function sender() {
  const service = {
    materializeSession: async () => ({ getState: () => ({}), subscribe: () => () => {} }),
    submitSession: async () => ({ accepted: true }),
  };
  const agentTasks = createAgentTaskSessions({
    getSessionService: () => service,
    deliver: async () => {},
    watches: { add: async () => {}, list: async () => [], remove: async () => {} },
    loadSession: async (id) => loadSession(id),
    agentName: async (id) => `Name ${id}`,
    pendingWork: async () => false,
    settleMs: 0,
    log: () => {},
  });
  const run = createSessionControl({ getSessionService: () => service, agentTasks });
  return (sessionId, { callerAgentId = 'a', callerSessionId = HOME } = {}) =>
    run(
      { action: 'send', session_id: sessionId, prompt: 'continue' },
      { callerSessionId, callerAgentId, callerHop: 0 }
    );
}

test("the attended chat's send into a task session a run created makes it attended", async () => {
  const id = taskSession('sess_task_sd_a', { run: true });
  assert.equal(unattendedRunOf(id)?.kind, 'schedule');
  await sender()(id);
  assert.equal(unattendedRunOf(id), null, 'the chat drives it now');
  assert.equal(loadSession(id).delegation, undefined, 'a task session is never delegated');
});

test("a run's send into a task session the chat created makes it the run's", async () => {
  const id = taskSession('sess_task_sd_b');
  assert.equal(unattendedRunOf(id), null);
  const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'a', name: 'Hook' });
  try {
    await sender()(id);
  } finally {
    unmark();
  }
  assert.deepEqual(unattendedRunOf(id), { kind: 'webhook', agentId: 'a', name: 'Hook' });
});

test("an attended sender that is no bot (the fallback send) makes a run's task session attended too", async () => {
  const id = taskSession('sess_task_sd_d', { run: true });
  await sender()(id, { callerAgentId: '', callerSessionId: HOME });
  assert.equal(unattendedRunOf(id), null);
});

test('the fallback send keeps the in-flight protection: a running attended turn is not made a run', async () => {
  const id = taskSession('sess_task_sd_e');
  runtimeState.set(id, { stage: 'tool_running' });
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'a', name: 'Daily' });
  try {
    await sender()(id, { callerAgentId: '', callerSessionId: HOME });
  } finally {
    unmark();
    runtimeState.delete(id);
  }
  assert.equal(unattendedRunOf(id), null);
});

test("another bot's send keeps a task session's own status", async () => {
  const id = taskSession('sess_task_sd_c', { run: true });
  await sender()(id, { callerAgentId: 'b', callerSessionId: 'sess_home_b' });
  assert.equal(unattendedRunOf(id)?.kind, 'schedule', 'a message from elsewhere does not change whose task it is');
});
