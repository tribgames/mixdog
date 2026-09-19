import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionHostPublication } from './session-host-publication.ts';

function owner(overrides = {}) {
  let disposed = false;
  let controlSessionId = '';
  const visible = new Set();
  const reads = [];
  const tracked = [];
  let shells = 0;
  const held = [];
  return {
    isDisposed: () => disposed,
    controlSessionId: () => controlSessionId,
    setControlSessionId: (id) => {
      controlSessionId = id;
    },
    visibleSessionIds: () => visible,
    async readSession(sessionId) {
      reads.push(sessionId);
      if (held.length) {
        const pending = held.shift();
        pending.captured.resolve();
        await pending.release.promise;
      }
      return { sessionId, items: [], queued: [] };
    },
    snapshotWithShellJobs: (_id, snapshot) => snapshot,
    trackShellJobsEngineState: (snapshot) => {
      tracked.push(snapshot);
    },
    onShellPublished: () => {
      shells += 1;
    },
    dispose() {
      disposed = true;
    },
    visible,
    reads,
    tracked,
    shells: () => shells,
    holdRead() {
      const captured = Promise.withResolvers();
      const release = Promise.withResolvers();
      held.push({ captured, release });
      return { captured: captured.promise, release: release.resolve };
    },
    ...overrides,
  };
}

test('subscribe does not deliver the current snapshot until a later publish', () => {
  const publication = new SessionHostPublication(owner());
  const shells = [];
  publication.subscribe((snapshot) => shells.push(snapshot));
  assert.deepEqual(shells, []);
  publication.publishShell({ sessionId: '', items: [], queued: [] });
  assert.equal(shells.length, 1);
  assert.equal(shells[0].remoteEnabled, false);
});

test('a thrown session-state listener cannot prevent the next listener from receiving the frame', () => {
  const publication = new SessionHostPublication(owner());
  const seen = [];
  publication.subscribeSessionStates(() => {
    throw new Error('listener failed');
  });
  publication.subscribeSessionStates((update) => seen.push(update.sessionId));
  publication.publishSession('lead', { sessionId: 'lead', items: [], queued: [] });
  assert.deepEqual(seen, ['lead']);
});

test('older revisions and same-revision patches do not roll the projection back', () => {
  const lane = owner();
  const publication = new SessionHostPublication(lane);
  const updates = [];
  publication.subscribeSessionStates((update) => updates.push(update));
  const first = publication.applySessionResult('lead', {
    sessionId: 'lead',
    revision: 2,
    full: { sessionId: 'lead', model: 'new', items: [], queued: [] },
  });
  assert.equal(first.model, 'new');
  assert.equal(updates.length, 1);
  const stale = publication.applySessionResult('lead', {
    sessionId: 'lead',
    revision: 1,
    full: { sessionId: 'lead', model: 'old', items: [], queued: [] },
  });
  assert.equal(stale.model, 'new');
  assert.equal(updates.length, 1);
  const repeat = publication.applySessionResult('lead', {
    sessionId: 'lead',
    revision: 2,
    baseRevision: 1,
    patch: { set: { fast: true } },
  });
  assert.equal(repeat.model, 'new');
  assert.equal(repeat.fast, undefined);
  assert.equal(updates.length, 1);
});

test('a crossed patch recovers by re-reading and does not publish an empty live frame', async () => {
  const lane = owner();
  const publication = new SessionHostPublication(lane);
  const updates = [];
  publication.subscribeSessionStates((update) => updates.push(update));
  const previous = console.error;
  console.error = () => {};
  try {
    const held = lane.holdRead();
    const returned = publication.applySessionResult('lead', {
      sessionId: 'lead',
      revision: 3,
      baseRevision: 1,
      patch: { set: { fast: true } },
    });
    assert.deepEqual(returned.items, []);
    assert.equal(updates.length, 0);
    assert.deepEqual(lane.reads, ['lead']);
    publication.recoverMissingSessionBaseline('lead');
    assert.equal(lane.reads.length, 1, 'in-flight recovery is not stacked');
    await held.captured;
    held.release();
    await Promise.resolve();
  } finally {
    console.error = previous;
  }
});

test('control-session frames never publish and session-gone only clears that control id', () => {
  const lane = owner();
  lane.setControlSessionId('control');
  const publication = new SessionHostPublication(lane);
  const updates = [];
  publication.subscribeSessionStates((update) => updates.push(update));
  publication.applySessionResult('control', { sessionId: 'control', revision: 1 });
  assert.equal(updates.length, 0);
  publication.handleSessionFrame({ type: 'session-gone', sessionId: 'control' });
  assert.equal(lane.controlSessionId(), '');
  assert.equal(updates.length, 0);
});

test('session-gone names idle reclaim as unloaded and other teardowns as gone', () => {
  const publication = new SessionHostPublication(owner());
  const ends = [];
  publication.subscribeSessionStates((update) => ends.push(update.laneEnd));
  publication.handleSessionFrame({
    type: 'session-gone',
    sessionId: 'lead',
    reason: 'idle and unwatched',
  });
  publication.handleSessionFrame({ type: 'session-gone', sessionId: 'lead', reason: 'deleted' });
  assert.deepEqual(ends, ['unloaded', 'gone']);
});

test('a disposed host ignores frames', () => {
  const lane = owner();
  const publication = new SessionHostPublication(lane);
  const updates = [];
  publication.subscribeSessionStates((update) => updates.push(update));
  lane.dispose();
  publication.handleSessionFrame({
    type: 'session-state',
    sessionId: 'lead',
    revision: 1,
    full: { sessionId: 'lead' },
  });
  assert.equal(updates.length, 0);
});

test('transport loss reports disconnected for visible ids without blanking the reason', () => {
  const lane = owner();
  lane.visible.add('lead');
  const publication = new SessionHostPublication(lane);
  const updates = [];
  publication.subscribeSessionStates((update) => updates.push(update));
  publication.handleSessionTransportLoss();
  assert.equal(lane.controlSessionId(), '');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].laneEnd, 'disconnected');
  assert.equal(updates[0].snapshot, null);
});

test('remote session overlay republishes the shell and visible panes once', () => {
  const lane = owner();
  lane.visible.add('lead');
  const publication = new SessionHostPublication(lane);
  const shells = [];
  const states = [];
  publication.subscribe((snapshot) => shells.push(snapshot.remoteSessionId));
  publication.subscribeSessionStates((update) => states.push(update.snapshot.remoteSessionId));
  publication.applySessionResult(
    'lead',
    {
      sessionId: 'lead',
      revision: 1,
      full: { sessionId: 'lead', items: [], queued: [] },
    },
    false
  );
  publication.publishShell({ sessionId: '', items: [], queued: [] });
  publication.applyRemoteSessionState({ enabled: true, sessionId: 'phone_1' });
  assert.equal(lane.shells(), 2);
  assert.deepEqual(shells.at(-1), 'phone_1');
  assert.deepEqual(states.at(-1), 'phone_1');
  publication.applyRemoteSessionState({ enabled: true, sessionId: 'phone_1' });
  assert.equal(lane.shells(), 2, 'unchanged remote state is not republished');
});

test('resyncRequired and empty session ids do not apply a live frame', () => {
  const lane = owner();
  const publication = new SessionHostPublication(lane);
  publication.handleSessionFrame({ type: 'session-state', sessionId: '', revision: 1, full: {} });
  publication.handleSessionFrame({
    type: 'session-state',
    sessionId: 'lead',
    revision: 1,
    resyncRequired: true,
    full: { items: [] },
  });
  assert.deepEqual(lane.reads, ['lead']);
  assert.equal(publication.projections.size, 0);
});

function applySnapshot(publication, id, fields = {}, revision = 1) {
  return publication.applySessionResult(id, {
    sessionId: id,
    revision,
    projection: true,
    full: { sessionId: id, items: [], queued: [], ...fields },
  });
}

test('unwatched projections obey LRU count and byte budgets without truncating a reply', () => {
  const lane = owner();
  const publication = new SessionHostPublication(lane, {
    maxUnwatchedEntries: 2,
    maxUnwatchedBytes: 4_096,
  });
  applySnapshot(publication, 'a');
  applySnapshot(publication, 'b');
  publication.applySessionResult('a', { sessionId: 'a', revision: 1, unchanged: true });
  applySnapshot(publication, 'c');
  assert.deepEqual([...publication.projections.keys()], ['a', 'c']);
  const largeText = 'complete reply '.repeat(1_000);
  const reply = applySnapshot(publication, 'large', { items: [{ kind: 'assistant', text: largeText }] });
  assert.equal(reply.items[0].text, largeText);
  assert.equal(publication.projections.has('large'), false);
  assert.deepEqual([...publication.projections.keys()], ['a', 'c']);
});

test('visible, control, running, queued, and approval projections stay pinned above the cache budget', () => {
  const lane = owner();
  lane.visible.add('visible');
  lane.setControlSessionId('control');
  const publication = new SessionHostPublication(lane, { maxUnwatchedBytes: 0, maxUnwatchedEntries: 0 });
  applySnapshot(publication, 'visible');
  applySnapshot(publication, 'control');
  applySnapshot(publication, 'running', { busy: true });
  applySnapshot(publication, 'command', { commandBusy: true });
  applySnapshot(publication, 'queued', { queued: [{ id: 'pending' }] });
  applySnapshot(publication, 'approval', { toolApproval: { id: 'approve' } });
  applySnapshot(publication, 'cold');
  assert.deepEqual(
    [...publication.projections.keys()],
    ['visible', 'control', 'running', 'command', 'queued', 'approval']
  );
  lane.visible.clear();
  publication.pruneProjections();
  assert.equal(publication.projections.has('visible'), false);
  applySnapshot(publication, 'running', { busy: false }, 2);
  assert.equal(publication.projections.has('running'), false);
  assert.equal(publication.projections.has('approval'), true);
});

test('overlapping replays retain their full baselines until the last delivery releases them', () => {
  const publication = new SessionHostPublication(owner(), { maxUnwatchedBytes: 0 });
  const releaseFirst = publication.retainProjections(['replay', 'replay']);
  const releaseSecond = publication.retainProjections(['replay']);
  const snapshot = applySnapshot(publication, 'replay', { items: [{ kind: 'assistant', text: 'complete' }] });
  releaseFirst();
  releaseFirst();
  assert.equal(publication.projections.get('replay').snapshot.items[0].text, snapshot.items[0].text);
  releaseSecond();
  assert.equal(publication.projections.has('replay'), false);
});

test('a patch after cache eviction re-reads its baseline without publishing an empty frame', async () => {
  const lane = owner();
  const publication = new SessionHostPublication(lane, { maxUnwatchedBytes: 0 });
  const seen = [];
  publication.subscribeSessionStates((update) => seen.push(update.snapshot));
  applySnapshot(publication, 'cold', { items: [{ kind: 'assistant', text: 'original' }] });
  assert.equal(publication.projections.has('cold'), false);
  publication.handleSessionFrame({
    type: 'session-state',
    sessionId: 'cold',
    revision: 2,
    baseRevision: 1,
    patch: { set: { model: 'updated' } },
  });
  await Promise.resolve();
  assert.deepEqual(lane.reads, ['cold']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].items[0].text, 'original');
});
