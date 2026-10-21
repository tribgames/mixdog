// `agent send` and a `spawn` of an existing tag hand a worker new work from the
// calling session: from then on the worker is attended or a schedule/webhook
// run's exactly as that caller is (human-gate/delegation.mjs rebindDelegation).
// A background-task completion wake is the worker's own continuation and
// keeps what it was.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { setLiveSession } from '../../../runtime/agent/orchestrator/session/store.mjs';
import { loadSession } from '../../../runtime/agent/orchestrator/session/store/load-session.mjs';
import { sessionOriginFields } from '../../../runtime/agent/orchestrator/session/manager/session-record.mjs';
import { markUnattendedRun, unattendedRunOf } from '../../held-requests.mjs';
import { createSendDispatch } from './execute-send.mjs';
import { createSpawnDispatch } from './execute-spawn.mjs';
import { createSendFlow } from './send-flow.mjs';

// A re-bound record is saved: into this test's own store, never the user's.
const dataRoot = mkdtempSync(join(tmpdir(), 'send-flow-driver-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const HOME = 'sess_home_flowbot';

function worker(id, { run } = {}) {
  const unmark = run ? markUnattendedRun(HOME, { kind: 'schedule', agentId: 'flowbot', name: 'Nightly' }) : () => {};
  const record = {
    id,
    owner: 'agent',
    agent: 'worker',
    visibility: 'agent-only',
    parentSessionId: HOME,
    ownerSessionId: HOME,
    createdAt: Date.now(),
  };
  const origin = sessionOriginFields(record, {
    profile: null,
    presetObj: null,
    providerCacheOpts: null,
    surface: { toolPermission: null, hasCallerAllow: false },
  });
  setLiveSession({ ...record, ...(origin.delegation ? { delegation: origin.delegation } : {}) });
  unmark();
  return id;
}

/** The agent tool's send and spawn dispatch over real session records, with a
 *  busy worker (the prompt is queued: no turn runs). */
function tool(sessionId, { busy = true, startJob = () => ({}) } = {}) {
  const queued = [];
  const registry = {
    refreshTagsFromSessions() {},
    wantsSessionScan: () => false,
    resolveTag: () => sessionId,
    getLiveSession: () => loadSession(sessionId),
    tagForSession: () => 'w-email',
  };
  const sendFlow = createSendFlow({
    mgr: {
      getSession: loadSession,
      enqueuePendingMessage: (_id, prompt) => queued.push(prompt),
    },
    defaultCwd: process.cwd(),
    canUseSessionSurface: () => false,
    registry,
    views: { isSessionBusy: () => busy, renderJob: () => ({ status: 'running' }) },
    spawnFlow: { startJob },
  });
  const spawnResult = () => 'spawned';
  const { send } = createSendDispatch({ registry, defaultCwd: process.cwd(), sendFlow, spawnFlow: {}, spawnResult });
  const { spawn } = createSpawnDispatch({
    registry,
    terminalTrace: {},
    sendFlow,
    spawnFlow: {},
    spawnResult,
  });
  const request = (callerSessionId) => {
    const context = { callerSessionId, ownerSessionId: callerSessionId };
    return { callerCwd: process.cwd(), scopedContext: context, context, notifyContext: context };
  };
  return { queued, sendFlow, send, spawn, request };
}

for (const via of ['send', 'spawn']) {
  const reuse = ({ send, spawn, request }, caller) =>
    via === 'send'
      ? send({ tag: 'w-email', prompt: 'mail it' }, request(caller))
      : spawn({ tag: 'w-email', agent: 'worker', prompt: 'mail it' }, request(caller));

  test(`${via}: a worker a run started is attended when the chat reuses its tag`, async () => {
    const id = worker(`sess_fd_${via}_a`, { run: true });
    assert.equal(unattendedRunOf(id)?.kind, 'schedule');
    const out = await reuse(tool(id), HOME);
    assert.match(out, /queued/);
    assert.equal(unattendedRunOf(id), null, 'the chat drives it now: it asks');
    assert.equal(loadSession(id).delegation.via, 'home');
  });

  test(`${via}: a worker the chat started is the run's when a run reuses its tag`, async () => {
    const id = worker(`sess_fd_${via}_b`);
    assert.equal(unattendedRunOf(id), null);
    const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'flowbot', name: 'Hook' });
    try {
      await reuse(tool(id), HOME);
    } finally {
      unmark();
    }
    assert.deepEqual(unattendedRunOf(id), { kind: 'webhook', agentId: 'flowbot', name: 'Hook' });
  });
}

test("a completion wake continues the worker as it was: a run's worker stays the run's", async () => {
  const id = worker('sess_fd_wake', { run: true });
  const started = [];
  const { sendFlow } = tool(id, {
    busy: false,
    startJob: (kind, meta) => {
      started.push([kind, meta.sessionId]);
      return {};
    },
  });
  assert.equal(sendFlow.wakeIdleWorker(id), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [['send', id]], 'the wake ran as a send job');
  assert.equal(unattendedRunOf(id)?.kind, 'schedule', 'its owner is attended now, but the wake is not its send');
  assert.equal(loadSession(id).delegation.via, 'run');
});
