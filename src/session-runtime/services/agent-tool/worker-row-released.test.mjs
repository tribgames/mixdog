// An agent its owner closed (the agent tool's `close`) stays released across a
// daemon restart plus a session scan, until a turn of any origin starts on it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { runtimeState } from '../../../runtime/agent/orchestrator/session/manager/runtime-state.mjs';
import { markSessionAskStart } from '../../../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs';

mock.module('../../../vendor/statusline/src/gateway/session-routes.mjs', {
  namedExports: {
    clearGatewaySessionRoute: () => true,
    writeGatewaySessionRoutes: () => true,
  },
});
const { createTagRegistry } = await import('./tag-registry.mjs');
const { createCloseFlow } = await import('./close-flow.mjs');
const { createSendFlow } = await import('./send-flow.mjs');
const { createSendDispatch } = await import('./execute-send.mjs');

const LEAD = 'lead-rel';
const iso = new Date().toISOString();
const session = {
  id: 'sess_rel_1',
  agentTag: 'rev',
  ownerSessionId: LEAD,
  parentSessionId: LEAD,
  agent: 'reviewer',
  provider: 'anthropic-oauth',
  status: 'idle',
  createdAt: iso,
  updatedAt: iso,
  lastUsedAt: iso,
};
const context = { callerSessionId: LEAD, ownerSessionId: LEAD };

function boot(root, mgr) {
  return createTagRegistry({ dataDir: root, cfgMod: { loadConfig: () => ({}) }, mgr, emitSubagentEvent: () => {} });
}

const rowOf = (registry) => registry.readWorkerRows(context).find((row) => row.tag === 'rev');
const readMarkers = (root) => JSON.parse(readFileSync(join(root, 'agent-workers-released.json'), 'utf8')).released;

// The shared boundary every turn start passes through (a user message, an
// answer, an auto-resume, a send): the runtime marks the ask started.
function startTurn(sessionId) {
  markSessionAskStart(sessionId);
  runtimeState.delete(sessionId);
}

function makeManager() {
  return {
    getSession: (id) => (id === session.id ? session : null),
    listSessions: () => [session],
    getSessionRuntime: () => null,
    // closeSession with { tombstone: false } leaves the session open and resumable.
    closeSession: () => true,
    hideSessionFromList: () => {},
    unloadSessionRuntime: () => {},
  };
}

/** A bound idle agent that the Lead then closes; the first daemon is gone. */
async function closedAgent(root, mgr) {
  const first = boot(root, mgr);
  first.bindTag('rev', session, { status: 'idle' });
  await first.flushIndexWrites();
  await createCloseFlow({ mgr, registry: first, views: {} }).close({ tag: 'rev' }, context);
  await first.flushIndexWrites();
  first.dispose();
}

async function restartedScan(root, mgr) {
  const registry = boot(root, mgr);
  registry.refreshTagsFromSessions({ scanSessions: true, context });
  await registry.flushIndexWrites();
  return registry;
}

test('a turn started outside send-flow clears the marker for good', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-release-turn-'));
  try {
    const mgr = makeManager();
    await closedAgent(root, mgr);
    const second = await restartedScan(root, mgr);
    assert.equal(rowOf(second)?.released, true);

    // The user types into the agent's session: no send-flow involved.
    startTurn(session.id);
    second.upsertWorkerSession(session, 'rev', { status: 'running' });
    second.upsertWorkerSession(session, 'rev', { status: 'idle' });
    await second.flushIndexWrites();
    assert.equal('released' in rowOf(second), false, 'not hidden again when the turn settles');
    assert.equal(session.id in readMarkers(root), false, 'the marker is gone from disk');
    second.dispose();

    const third = await restartedScan(root, mgr);
    assert.equal('released' in rowOf(third), false, 'a later restart does not release it again');
    third.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an index rewritten by a legacy-shaped writer keeps the marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-release-legacy-'));
  try {
    const mgr = makeManager();
    await closedAgent(root, mgr);
    // An older daemon rebuilds the index document from the keys it knows.
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), workers: {}, tombstones: {} })
    );
    const second = await restartedScan(root, mgr);
    assert.equal(rowOf(second)?.released, true);
    second.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the marker expires after 7 days on read, with the file unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-release-expiry-'));
  const day = 24 * 60 * 60 * 1000;
  try {
    const mgr = makeManager();
    await closedAgent(root, mgr);
    const before = readFileSync(join(root, 'agent-workers-released.json'), 'utf8');
    const second = boot(root, mgr);
    const realNow = Date.now();
    const clock = mock.method(Date, 'now', () => realNow + 6 * day);
    try {
      second.upsertWorkerSession(session, 'rev', { status: 'idle' });
      assert.equal(rowOf(second)?.released, true, 'still released on day 6');
      clock.mock.mockImplementation(() => realNow + 8 * day);
      second.upsertWorkerSession(session, 'rev', { status: 'idle' });
      assert.equal('released' in rowOf(second), false, 'expired on day 8');
    } finally {
      clock.mock.restore();
    }
    assert.equal(readFileSync(join(root, 'agent-workers-released.json'), 'utf8'), before);
    second.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('close → restart + scan keeps the agent released; a send to its tag lists it again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-release-restart-'));
  try {
    const mgr = makeManager();
    const first = boot(root, mgr);
    first.bindTag('rev', session, { status: 'idle' });
    await first.flushIndexWrites();
    assert.equal('released' in rowOf(first), false);

    await createCloseFlow({ mgr, registry: first, views: {} }).close({ tag: 'rev' }, context);
    await first.flushIndexWrites();
    assert.equal(rowOf(first), undefined, 'the closed agent has no row');
    assert.ok(readMarkers(root)[session.id], 'the marker is persisted in its own file');
    assert.equal('released' in JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8')), false);
    first.dispose();

    // A restarted daemon: fresh tag maps and caches over the same data dir; the
    // session scan finds the still-open session and re-adds its row.
    const second = boot(root, mgr);
    second.refreshTagsFromSessions({ scanSessions: true, context });
    await second.flushIndexWrites();
    assert.equal(rowOf(second)?.released, true, 'the re-added row is still released');

    let started = 0;
    const sendFlow = createSendFlow({
      mgr,
      defaultCwd: process.cwd(),
      canUseSessionSurface: () => false,
      registry: second,
      views: { isSessionBusy: () => false, renderJob: () => ({ status: 'running' }) },
      spawnFlow: { startJob: () => ++started },
    });
    const { send } = createSendDispatch({
      registry: second,
      defaultCwd: process.cwd(),
      sendFlow,
      spawnFlow: {},
      spawnResult: () => 'spawned',
    });
    await send(
      { tag: 'rev', prompt: 'again' },
      { callerCwd: process.cwd(), scopedContext: context, context, notifyContext: context }
    );
    assert.equal(started, 1, 'the send reached the closed agent');
    // The send's turn starts (the job above is a stub) and writes its row.
    startTurn(session.id);
    second.upsertWorkerSession(session, 'rev', { status: 'running' });
    await second.flushIndexWrites();
    assert.equal('released' in rowOf(second), false, 'a reused agent is not released');

    // And a later restart + scan does not release it again.
    second.dispose();
    const third = boot(root, mgr);
    third.refreshTagsFromSessions({ scanSessions: true, context });
    assert.equal('released' in rowOf(third), false);
    third.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
