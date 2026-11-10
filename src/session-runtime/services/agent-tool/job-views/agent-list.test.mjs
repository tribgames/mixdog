import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentList, isActiveWorkerRow } from './agent-list.mjs';
import { createSessionProgress } from './session-progress.mjs';

// A Lead with hundreds of finished workers: the status pulse (every 2 s per
// runtime) lists only the working ones, and a finished worker's progress
// (its session's stored status, read from its whole transcript the first
// time) must not be computed just to be filtered out.
function listOver(sessions) {
  const progressed = [];
  const list = createAgentList({
    mgr: {},
    refreshTagsFromSessions: () => {},
    agentSessionEntries: () => sessions.map((session) => ({ tag: session.id, session, indexRow: null })),
    progress: {
      sessionProgressExtras(sessionId) {
        progressed.push(sessionId);
        return { worker_stage: 'streaming' };
      },
    },
  });
  return { list, progressed };
}

const finished = Array.from({ length: 50 }, (_, index) => ({ id: `done-${index}`, status: 'idle' }));
const working = { id: 'live', status: 'running', stage: 'streaming' };

test('the default agent list reads progress only for the workers it returns', () => {
  const { list, progressed } = listOver([...finished, working]);
  const rows = list();
  assert.deepEqual(
    rows.map((row) => row.sessionId),
    ['live']
  );
  assert.equal(rows[0].worker_stage, 'streaming');
  assert.deepEqual(progressed, ['live']);
});

// Rows whose session status, session stage, runtime stage and progress
// snapshot disagree, or that carry no status at all. The list now decides
// which rows are active before their progress is merged in; the merged row
// must decide the same way, which holds because the progress producer never
// writes `status` or `stage`.
const disagreeing = [
  { id: 'idle-but-streaming', status: 'idle', stage: 'streaming' },
  { id: 'running-but-idle-stage', status: 'running', stage: 'idle' },
  { id: 'no-status-streaming', stage: 'streaming' },
  { id: 'no-status-no-stage' },
  { id: 'no-status-runtime-streaming', runtimeStage: 'streaming' },
  { id: 'running-runtime-tool', status: 'running', runtimeStage: 'tool_running' },
  { id: 'running-snapshot-only', status: 'running', snapshotStage: 'requesting' },
  { id: 'closed-but-running', status: 'running', closed: true, runtimeStage: 'streaming' },
  { id: 'error-runtime-streaming', status: 'error', runtimeStage: 'streaming' },
  { id: 'cancelled-stage', status: 'running', stage: 'cancelled' },
  { id: 'cancel-pending-status', status: 'cancel-pending', runtimeStage: 'streaming' },
  { id: 'unknown-status', status: 'unknown', snapshotStage: 'streaming' },
  { id: 'completed-status', status: 'completed', runtimeStage: 'streaming' },
  { id: 'queued-followups', status: 'running', queued: 2 },
  { id: 'loaded-entry', status: 'running', stage: 'streaming', loaded: true },
];

function realProgressList(cases) {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const mgr = {
    loadSessionStatus: (id) => byId.get(id)?.status ?? null,
    getSessionRuntime: (id) => (byId.get(id)?.runtimeStage ? { stage: byId.get(id).runtimeStage } : null),
    getSessionProgressSnapshot: (id) => (byId.get(id)?.snapshotStage ? { stage: byId.get(id).snapshotStage } : null),
    getSessionPendingMessageDepth: (id) => byId.get(id)?.queued ?? 0,
  };
  const progress = createSessionProgress({ mgr });
  const list = createAgentList({
    mgr,
    refreshTagsFromSessions: () => {},
    agentSessionEntries: () =>
      cases.map(({ id, status, stage, closed, loaded }) => ({
        tag: id,
        session: { id, agent: 'worker', ...(status ? { status } : {}), ...(stage ? { stage } : {}), closed },
        indexRow: null,
        loaded: loaded === true,
      })),
    progress,
  });
  return { list, progress };
}

test('the progress producer never writes status or stage', () => {
  const { progress } = realProgressList(disagreeing);
  for (const { id } of disagreeing) {
    for (const taskStatus of [null, 'running', 'completed', 'failed', 'cancelled']) {
      const fields = progress.sessionProgressExtras(id, 'worker', Date.now(), taskStatus);
      assert.ok(!('status' in fields) && !('stage' in fields), `${id}/${taskStatus}: ${Object.keys(fields)}`);
    }
  }
});

test('filtering before the progress merge returns the rows filtering the merged rows did', () => {
  const { list } = realProgressList(disagreeing);
  // includeTerminal is the unfiltered merged list; filtering it is what the
  // default list returned before the change.
  const merged = list({ includeTerminal: true });
  assert.equal(merged.length, disagreeing.length);
  const before = merged.filter((row) => isActiveWorkerRow(row));
  const after = list();
  assert.deepEqual(after, before);
  // Both sides of the disagreement are represented in the answer.
  const listed = new Set(after.map((row) => row.sessionId));
  assert.ok(listed.has('running-but-idle-stage'));
  assert.ok(!listed.has('idle-but-streaming'));
});

test('includeTerminal still reads every listed worker', () => {
  const { list, progressed } = listOver([...finished, working]);
  assert.equal(list({ includeTerminal: true }).length, 51);
  assert.equal(progressed.length, 51);
});
